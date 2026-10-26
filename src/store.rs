use crate::wire::*;
use prost::Message;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

pub struct Store(pub Connection);
#[derive(Clone)]
pub struct Device {
    pub key: Vec<u8>,
}
#[derive(Clone)]
pub struct Member {
    pub user: String,
    pub roles: Vec<i32>,
}
fn db<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| ErrorCode::Internal)
}
fn hash(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}
impl Store {
    pub fn open(path: &str) -> anyhow::Result<Self> {
        if let Some(parent) = std::path::Path::new(path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(3))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS harnesses (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, display_name TEXT NOT NULL, acl_version INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS members (harness_id TEXT NOT NULL REFERENCES harnesses(id), device_id TEXT NOT NULL REFERENCES devices(id), role INTEGER NOT NULL, PRIMARY KEY(harness_id,device_id));
          CREATE TABLE IF NOT EXISTS pairs (code_hash BLOB PRIMARY KEY, id TEXT NOT NULL, harness_id TEXT NOT NULL REFERENCES harnesses(id), mode INTEGER NOT NULL, user_id TEXT, role INTEGER NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX IF NOT EXISTS pending_owner ON pairs(harness_id) WHERE mode=1 AND consumed=0;
          CREATE TABLE IF NOT EXISTS mutations (scope TEXT NOT NULL, operation_id TEXT NOT NULL, digest BLOB NOT NULL, response BLOB NOT NULL, PRIMARY KEY(scope,operation_id));")?;
        c.execute(
            "INSERT OR IGNORE INTO settings VALUES ('relay_id',?1)",
            [id()],
        )?;
        Ok(Self(c))
    }
    pub fn relay_id(&self) -> anyhow::Result<String> {
        Ok(self
            .0
            .query_row("SELECT value FROM settings WHERE key='relay_id'", [], |r| {
                r.get(0)
            })?)
    }
    pub fn harness_key(&self, h: &str) -> Result<Vec<u8>> {
        db(self
            .0
            .query_row("SELECT public_key FROM harnesses WHERE id=?1", [h], |r| {
                r.get(0)
            })
            .optional())?
        .ok_or(ErrorCode::Unauthenticated)
    }
    pub fn register(&self, r: &HarnessRegisterRequest) -> Result<()> {
        require(
            !r.harness_id.is_empty()
                && r.harness_id.len() <= 128
                && r.display_name.len() <= 256
                && valid_key(&r.public_key),
            ErrorCode::InvalidArgument,
        )?;
        let old = db(self
            .0
            .query_row(
                "SELECT public_key FROM harnesses WHERE id=?1",
                [&r.harness_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional())?;
        if let Some(key) = old {
            return require(key == r.public_key, ErrorCode::Forbidden);
        }
        db(self.0.execute(
            "INSERT INTO harnesses(id,public_key,display_name) VALUES (?1,?2,?3)",
            params![r.harness_id, r.public_key, r.display_name],
        ))?;
        Ok(())
    }
    pub fn device(&self, d: &str) -> Result<Device> {
        db(self
            .0
            .query_row("SELECT public_key FROM devices WHERE id=?1", [d], |r| {
                Ok(Device { key: r.get(0)? })
            })
            .optional())?
        .ok_or(ErrorCode::Unauthenticated)
    }
    pub fn member(&self, h: &str, d: &str) -> Result<Member> {
        db(self.0.query_row("SELECT d.user_id,m.role FROM members m JOIN devices d ON d.id=m.device_id WHERE m.harness_id=?1 AND m.device_id=?2", params![h,d], |r| Ok(Member{ user:r.get(0)?, roles:vec![r.get(1)?] })).optional())?.ok_or(ErrorCode::Forbidden)
    }
    pub fn version(&self, h: &str) -> Result<u64> {
        let value: i64 =
            db(self
                .0
                .query_row("SELECT acl_version FROM harnesses WHERE id=?1", [h], |r| {
                    r.get(0)
                }))?;
        u64::try_from(value).map_err(|_| ErrorCode::Internal)
    }
    pub fn snapshot(&self, h: &str) -> Result<MembershipSnapshotRequest> {
        let mut q=db(self.0.prepare("SELECT d.id,d.user_id,d.public_key,m.role FROM members m JOIN devices d ON d.id=m.device_id WHERE m.harness_id=?1 ORDER BY d.id"))?;
        let rows = db(q.query_map([h], |r| {
            Ok(Membership {
                device_id: r.get(0)?,
                user_id: r.get(1)?,
                public_key: r.get(2)?,
                roles: vec![r.get(3)?],
            })
        }))?;
        Ok(MembershipSnapshotRequest {
            acl_version: self.version(h)?,
            members: db(rows.collect())?,
        })
    }
    fn cached(&self, scope: &str, op: &str, digest: &[u8]) -> Result<Option<Response>> {
        require(
            !op.is_empty() && op.len() <= 128,
            ErrorCode::InvalidArgument,
        )?;
        let old = db(self
            .0
            .query_row(
                "SELECT digest,response FROM mutations WHERE scope=?1 AND operation_id=?2",
                params![scope, op],
                |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?)),
            )
            .optional())?;
        if let Some((prior, bytes)) = old {
            require(prior == digest, ErrorCode::IdempotencyConflict)?;
            return Response::decode(bytes.as_slice())
                .map(Some)
                .map_err(|_| ErrorCode::Internal);
        }
        Ok(None)
    }
    fn save(&self, scope: &str, op: &str, digest: &[u8], res: Res) -> Result<Res> {
        db(self.0.execute(
            "INSERT INTO mutations VALUES (?1,?2,?3,?4)",
            params![
                scope,
                op,
                digest,
                Response {
                    operation: Some(res.clone())
                }
                .encode_to_vec()
            ],
        ))?;
        Ok(res)
    }
    // Transaction includes consumed code, device/member binding, ACL version and replay receipt.
    pub fn create_pair(
        &mut self,
        r: &PairCreateRequest,
        scope: &str,
        user: Option<&str>,
        owner: bool,
        harness: bool,
    ) -> Result<Res> {
        let op = r
            .mutation
            .as_ref()
            .map(|m| m.client_operation_id.as_str())
            .unwrap_or("");
        let digest = hash(&r.encode_to_vec());
        if let Some(c) = self.cached(scope, op, &digest)? {
            return c.operation.ok_or(ErrorCode::Internal);
        }
        require(matches!(r.mode, 1..=3), ErrorCode::InvalidArgument)?;
        require(
            match r.mode {
                1 => harness,
                2 => user.is_some(),
                3 => owner,
                _ => false,
            },
            ErrorCode::Forbidden,
        )?;
        db(self.0.execute_batch("BEGIN IMMEDIATE"))?;
        let result = (|| {
            db(self
                .0
                .execute("DELETE FROM pairs WHERE expires<=?1", [now()]))?;
            if r.mode == 1 {
                let count: i64 = db(self.0.query_row(
                    "SELECT COUNT(*) FROM members WHERE harness_id=?1 AND role=1",
                    [&r.harness_id],
                    |row| row.get(0),
                ))?;
                require(count == 0, ErrorCode::Forbidden)?;
                let pending: i64 = db(self.0.query_row(
                    "SELECT COUNT(*) FROM pairs WHERE harness_id=?1 AND mode=1 AND consumed=0",
                    [&r.harness_id],
                    |row| row.get(0),
                ))?;
                require(pending == 0, ErrorCode::AgentBusy)?;
            }
            let code = hex::encode(random_bytes());
            let pid = id();
            let expires = now() + 300;
            let role = if r.mode == 1 || (r.mode == 2 && owner) {
                1
            } else {
                2
            };
            db(self.0.execute(
                "INSERT INTO pairs VALUES (?1,?2,?3,?4,?5,?6,?7,0)",
                params![
                    hash(code.as_bytes()),
                    pid,
                    r.harness_id,
                    r.mode,
                    if r.mode == 2 { user } else { None },
                    role,
                    expires
                ],
            ))?;
            self.save(
                scope,
                op,
                &digest,
                Res::PairCreate(PairCreateResponse {
                    pairing_id: pid,
                    pairing_code: code,
                    expires_at: Some(timestamp(expires)),
                }),
            )
        })();
        self.finish(result)
    }
    pub fn redeem_pair(&mut self, r: &PairRedeemRequest) -> Result<Res> {
        require(
            !r.device_id.is_empty() && r.device_id.len() <= 128 && valid_key(&r.public_key),
            ErrorCode::InvalidArgument,
        )?;
        let message = transcript(
            b"HRP-PAIR-v1",
            &[
                r.pairing_code.as_bytes(),
                r.device_id.as_bytes(),
                &r.public_key,
            ],
        );
        require(
            verify(&r.public_key, &message, &r.possession_signature),
            ErrorCode::Unauthenticated,
        )?;
        let scope = format!("redeem:{}", r.device_id);
        let op = r
            .mutation
            .as_ref()
            .map(|m| m.client_operation_id.as_str())
            .unwrap_or("");
        let digest = hash(&r.encode_to_vec());
        if let Some(c) = self.cached(&scope, op, &digest)? {
            return c.operation.ok_or(ErrorCode::Internal);
        }
        db(self.0.execute_batch("BEGIN IMMEDIATE"))?;
        let result = (|| {
            let pair=db(self.0.query_row("SELECT harness_id,user_id,role FROM pairs WHERE code_hash=?1 AND consumed=0 AND expires>?2",params![hash(r.pairing_code.as_bytes()),now()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,i32>(2)?))).optional())?.ok_or(ErrorCode::Forbidden)?;
            let (h, u, role) = pair;
            let user = u.unwrap_or_else(id);
            let existing = db(self
                .0
                .query_row(
                    "SELECT user_id,public_key FROM devices WHERE id=?1",
                    [&r.device_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
                )
                .optional())?;
            if let Some((old, key)) = existing {
                require(old == user && key == r.public_key, ErrorCode::Forbidden)?;
            }
            db(self.0.execute(
                "INSERT OR IGNORE INTO devices VALUES (?1,?2,?3)",
                params![r.device_id, user, r.public_key],
            ))?;
            db(self.0.execute(
                "INSERT INTO members VALUES (?1,?2,?3)",
                params![h, r.device_id, role],
            ))?;
            db(self.0.execute(
                "UPDATE pairs SET consumed=1 WHERE code_hash=?1",
                [hash(r.pairing_code.as_bytes())],
            ))?;
            db(self.0.execute(
                "UPDATE harnesses SET acl_version=acl_version+1 WHERE id=?1",
                [&h],
            ))?;
            self.save(
                &scope,
                op,
                &digest,
                Res::PairRedeem(PairRedeemResponse {
                    user_id: user,
                    device_id: r.device_id.clone(),
                    harness_id: h.clone(),
                    acl_version: self.version(&h)?,
                }),
            )
        })();
        self.finish(result)
    }
    fn finish<T>(&self, result: Result<T>) -> Result<T> {
        match result {
            Ok(r) => {
                if let Err(error) = db(self.0.execute_batch("COMMIT")) {
                    let _ = self.0.execute_batch("ROLLBACK");
                    return Err(error);
                }
                Ok(r)
            }
            Err(e) => {
                let _ = self.0.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn owner_pair(store: &mut Store) -> (PairRedeemRequest, String) {
        let key = SigningKey::from_bytes(&[7; 32]);
        store
            .register(&HarnessRegisterRequest {
                harness_id: "h".into(),
                public_key: key.verifying_key().to_bytes().to_vec(),
                display_name: "test".into(),
            })
            .unwrap();
        let create = PairCreateRequest {
            mutation: Some(Mutation {
                client_operation_id: "create".into(),
            }),
            harness_id: "h".into(),
            mode: 1,
        };
        let Res::PairCreate(pair) = store
            .create_pair(&create, "harness:h", None, false, true)
            .unwrap()
        else {
            panic!()
        };
        let public_key = key.verifying_key().to_bytes().to_vec();
        let signature = key.sign(&transcript(
            b"HRP-PAIR-v1",
            &[pair.pairing_code.as_bytes(), b"d", &public_key],
        ));
        (
            PairRedeemRequest {
                mutation: Some(Mutation {
                    client_operation_id: "redeem".into(),
                }),
                pairing_code: pair.pairing_code.clone(),
                device_id: "d".into(),
                public_key,
                possession_signature: signature.to_bytes().to_vec(),
            },
            pair.pairing_code,
        )
    }
    #[test]
    fn failed_membership_write_rolls_back_device_code_and_receipt() {
        let mut store = Store::open(":memory:").unwrap();
        let (redeem, _) = owner_pair(&mut store);
        store.0.execute_batch("CREATE TRIGGER simulate_disk_error BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert_eq!(store.redeem_pair(&redeem), Err(ErrorCode::Internal));
        assert_eq!(store.version("h").unwrap(), 0);
        assert!(store.device("d").is_err());
        let consumed: i64 = store
            .0
            .query_row("SELECT consumed FROM pairs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(consumed, 0);
        store
            .0
            .execute_batch("DROP TRIGGER simulate_disk_error")
            .unwrap();
        assert!(store.redeem_pair(&redeem).is_ok());
        assert_eq!(store.version("h").unwrap(), 1);
    }
    #[test]
    fn pairing_receipt_survives_reopen_without_repeating_membership_effects() {
        let directory = std::env::temp_dir().join(format!("hrp-store-{}", id()));
        let path = directory.join("relay.sqlite3");
        let mut store = Store::open(path.to_str().unwrap()).unwrap();
        let relay_id = store.relay_id().unwrap();
        let (mut redeem, _) = owner_pair(&mut store);
        let receipt = store.redeem_pair(&redeem).unwrap();
        drop(store);
        let mut reopened = Store::open(path.to_str().unwrap()).unwrap();
        assert_eq!(reopened.relay_id().unwrap(), relay_id);
        assert_eq!(reopened.redeem_pair(&redeem).unwrap(), receipt);
        assert_eq!(reopened.version("h").unwrap(), 1);
        redeem.mutation.as_mut().unwrap().client_operation_id = "new-redeem".into();
        assert_eq!(reopened.redeem_pair(&redeem), Err(ErrorCode::Forbidden));
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
