use crate::{store::Store, wire::*};
use prost::Message;
use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Peer {
    Mobile,
    Harness,
}
#[derive(Clone)]
enum Identity {
    Mobile(String),
    Harness(String),
}
struct Challenge {
    identity: String,
    key: Vec<u8>,
    nonce: Vec<u8>,
    id: String,
    expires: i64,
}
struct Client {
    peer: Peer,
    identity: Option<Identity>,
    challenge: Option<Challenge>,
    tx: mpsc::Sender<Vec<u8>>,
    close: watch::Sender<bool>,
    registration: bool,
    expires: i64,
    ip: IpAddr,
}
struct Online {
    connection: String,
    synced: Option<u64>,
}
struct Route {
    harness: String,
    harness_connection: String,
    mobile: String,
    request: Envelope,
    operation: Req,
    expires: Instant,
}
struct SyncRoute {
    harness: String,
    connection: String,
    version: u64,
    request_id: String,
    expires: Instant,
}
struct Subscription {
    harness: String,
    harness_connection: String,
    mobile: String,
    session: String,
}
pub struct Hub {
    store: Store,
    pub relay_id: String,
    clients: HashMap<String, Client>,
    online: HashMap<String, Online>,
    routes: HashMap<String, Route>,
    sync: HashMap<String, SyncRoute>,
    subscriptions: HashMap<(String, String), Subscription>,
    attempts: HashMap<(IpAddr, bool), (Instant, u32)>,
}
impl Hub {
    pub fn new(store: Store) -> anyhow::Result<Self> {
        Ok(Self {
            relay_id: store.relay_id()?,
            store,
            clients: HashMap::new(),
            online: HashMap::new(),
            routes: HashMap::new(),
            sync: HashMap::new(),
            subscriptions: HashMap::new(),
            attempts: HashMap::new(),
        })
    }
    pub fn connect(
        &mut self,
        peer: Peer,
        registration: bool,
        ip: IpAddr,
        tx: mpsc::Sender<Vec<u8>>,
        close: watch::Sender<bool>,
    ) -> Option<String> {
        if self.clients.len() >= 4096 || !self.rate(ip, false, 120) {
            return None;
        }
        let cid = id();
        self.clients.insert(
            cid.clone(),
            Client {
                peer,
                identity: None,
                challenge: None,
                tx,
                close,
                registration,
                expires: now() + 30,
                ip,
            },
        );
        Some(cid)
    }
    fn rate(&mut self, ip: IpAddr, authenticated: bool, limit: u32) -> bool {
        let item = self
            .attempts
            .entry((ip, authenticated))
            .or_insert((Instant::now(), 0));
        if item.0.elapsed() > Duration::from_secs(60) {
            *item = (Instant::now(), 0);
        }
        item.1 += 1;
        item.1 <= limit
    }
    fn send(
        &self,
        cid: &str,
        envelope: Envelope,
        route_id: &str,
        principal: Option<Principal>,
        connection_id: &str,
    ) {
        if let Some(c) = self.clients.get(cid) {
            let bytes = match c.peer {
                Peer::Mobile => envelope.encode_to_vec(),
                Peer::Harness => RelayForward {
                    route_id: route_id.into(),
                    principal,
                    envelope: Some(envelope),
                    connection_id: connection_id.into(),
                }
                .encode_to_vec(),
            };
            if bytes.len() > MAX_FRAME || c.tx.try_send(bytes).is_err() {
                let _ = c.close.send(true);
            }
        }
    }
    fn fail(&self, cid: &str, request: &Envelope, code: ErrorCode) {
        eprintln!("rpc rejected connection={cid} code={}", code.as_str_name());
        self.send(cid, error(request, code), "", None, "");
    }
    fn principal(&self, h: &str, cid: &str) -> Result<Principal> {
        let c = self.clients.get(cid).ok_or(ErrorCode::Unauthenticated)?;
        require(c.expires > now(), ErrorCode::Unauthenticated)?;
        let Some(Identity::Mobile(d)) = &c.identity else {
            return Err(ErrorCode::Unauthenticated);
        };
        let m = self.store.member(h, d)?;
        Ok(Principal {
            user_id: m.user,
            device_id: d.clone(),
            roles: m.roles,
            acl_version: self.store.version(h)?,
        })
    }
    pub fn receive(&mut self, cid: &str, data: &[u8]) -> Result<()> {
        let c = self.clients.get(cid).ok_or(ErrorCode::Unauthenticated)?;
        let peer = c.peer;
        let ip = c.ip;
        let authenticated = c.identity.is_some();
        if c.expires <= now() {
            return Err(ErrorCode::Unauthenticated);
        }
        require(
            self.rate(ip, authenticated, if authenticated { 2400 } else { 120 }),
            ErrorCode::ResourceExhausted,
        )?;
        let (route, env) = match peer {
            Peer::Mobile => (
                String::new(),
                Envelope::decode(data).map_err(|_| ErrorCode::InvalidArgument)?,
            ),
            Peer::Harness => {
                let forward =
                    HarnessForward::decode(data).map_err(|_| ErrorCode::InvalidArgument)?;
                (
                    forward.route_id,
                    forward.envelope.ok_or(ErrorCode::InvalidArgument)?,
                )
            }
        };
        if env.version != 1 || env.request_id.is_empty() || env.request_id.len() > 128 {
            self.fail(cid, &env, ErrorCode::InvalidArgument);
            return Ok(());
        }
        if peer == Peer::Harness && authenticated && !route.is_empty() {
            self.harness_reply(cid, &route, env);
            return Ok(());
        }
        if peer == Peer::Harness && matches!(env.body, Some(Body::Event(_))) {
            self.harness_event(cid, env);
            return Ok(());
        }
        let operation = match &env.body {
            Some(Body::Request(r))
                if env.reply_to.is_none() && env.subscription_id.is_none() && route.is_empty() =>
            {
                r.operation.clone()
            }
            _ => {
                self.fail(cid, &env, ErrorCode::InvalidArgument);
                return Ok(());
            }
        };
        let result = match operation {
            Some(op) => self.request(cid, &env, op),
            None => Err(ErrorCode::UnsupportedOperation),
        };
        match result {
            Ok(Some(op)) => self.send(cid, response(&env, op), "", None, ""),
            Ok(None) => {}
            Err(e) => self.fail(cid, &env, e),
        }
        Ok(())
    }
    fn request(&mut self, cid: &str, env: &Envelope, op: Req) -> Result<Option<Res>> {
        let c = self.clients.get(cid).ok_or(ErrorCode::Unauthenticated)?;
        let identity = c.identity.clone();
        let peer = c.peer;
        match op {
            Req::HarnessRegister(r) => {
                require(
                    peer == Peer::Harness && identity.is_none() && c.registration,
                    ErrorCode::Forbidden,
                )?;
                self.store.register(&r)?;
                Ok(Some(Res::HarnessRegister(HarnessRegisterResponse {
                    harness_id: r.harness_id,
                })))
            }
            Req::AuthChallenge(r) => {
                require(identity.is_none(), ErrorCode::Forbidden)?;
                require(
                    r.identity_id.len() <= 128
                        && !r.identity_id.is_empty()
                        && r.peer_kind == if peer == Peer::Harness { 2 } else { 1 },
                    ErrorCode::InvalidArgument,
                )?;
                let key = if peer == Peer::Harness {
                    self.store.harness_key(&r.identity_id)?
                } else {
                    self.store.device(&r.identity_id)?.key
                };
                let nonce = random_bytes();
                let challenge_id = id();
                let expires = now() + 30;
                self.clients.get_mut(cid).unwrap().challenge = Some(Challenge {
                    identity: r.identity_id,
                    key,
                    nonce: nonce.clone(),
                    id: challenge_id.clone(),
                    expires,
                });
                Ok(Some(Res::AuthChallenge(AuthChallengeResponse {
                    challenge_id,
                    nonce,
                    expires_at: Some(timestamp(expires)),
                    relay_id: self.relay_id.clone(),
                })))
            }
            Req::AuthProve(r) => {
                require(identity.is_none(), ErrorCode::Forbidden)?;
                let challenge = self
                    .clients
                    .get_mut(cid)
                    .unwrap()
                    .challenge
                    .take()
                    .ok_or(ErrorCode::Unauthenticated)?;
                let kind = if peer == Peer::Harness {
                    b"harness".as_slice()
                } else {
                    b"mobile".as_slice()
                };
                let bytes = transcript(
                    b"HRP-AUTH-v1",
                    &[
                        self.relay_id.as_bytes(),
                        challenge.identity.as_bytes(),
                        kind,
                        challenge.id.as_bytes(),
                        &challenge.nonce,
                    ],
                );
                require(
                    challenge.id == r.challenge_id
                        && challenge.expires > now()
                        && verify(&challenge.key, &bytes, &r.signature),
                    ErrorCode::Unauthenticated,
                )?;
                if peer == Peer::Harness {
                    require(
                        !self.online.contains_key(&challenge.identity),
                        ErrorCode::AgentBusy,
                    )?;
                }
                let expires = now() + 86400;
                let c = self.clients.get_mut(cid).unwrap();
                c.expires = expires;
                c.identity = Some(if peer == Peer::Harness {
                    Identity::Harness(challenge.identity.clone())
                } else {
                    Identity::Mobile(challenge.identity.clone())
                });
                eprintln!("ws authenticated connection={cid}");
                // Auth response precedes the initial ACL snapshot.
                self.send(
                    cid,
                    response(
                        env,
                        Res::AuthProve(AuthProveResponse {
                            identity_id: challenge.identity.clone(),
                            expires_at: Some(timestamp(expires)),
                        }),
                    ),
                    "",
                    None,
                    "",
                );
                if peer == Peer::Harness {
                    self.online.insert(
                        challenge.identity.clone(),
                        Online {
                            connection: cid.into(),
                            synced: None,
                        },
                    );
                    self.sync_members(&challenge.identity)?;
                }
                Ok(None)
            }
            Req::PairCreate(r) => {
                let identity = identity.ok_or(ErrorCode::Unauthenticated)?;
                let (scope, user, owner, harness) = match identity {
                    Identity::Harness(h) => {
                        require(h == r.harness_id, ErrorCode::Forbidden)?;
                        (format!("harness:{h}"), None, false, true)
                    }
                    Identity::Mobile(_) => {
                        let p = self.principal(&r.harness_id, cid)?;
                        (
                            format!("user:{}", p.user_id),
                            Some(p.user_id),
                            p.roles.contains(&1),
                            false,
                        )
                    }
                };
                self.store
                    .create_pair(&r, &scope, user.as_deref(), owner, harness)
                    .map(Some)
            }
            Req::PairRedeem(r) => {
                require(
                    peer == Peer::Mobile && identity.is_none(),
                    ErrorCode::Forbidden,
                )?;
                let res = self.store.redeem_pair(&r)?;
                if let Res::PairRedeem(result) = &res {
                    let c = self.clients.get_mut(cid).unwrap();
                    c.identity = Some(Identity::Mobile(r.device_id));
                    c.challenge = None;
                    c.expires = now() + 86400;
                    self.sync_members(&result.harness_id)?;
                }
                Ok(Some(res))
            }
            Req::HarnessStatus(_) => {
                let h = env
                    .harness_id
                    .as_deref()
                    .ok_or(ErrorCode::InvalidArgument)?;
                self.principal(h, cid)?;
                Ok(Some(Res::HarnessStatus(HarnessStatusResponse {
                    online: self.online.contains_key(h),
                    adapter_version: String::new(),
                    acl_version: self.store.version(h)?,
                })))
            }
            Req::MemberRevoke(r) => {
                let Some(Identity::Harness(h)) = identity else {
                    return Err(ErrorCode::Forbidden);
                };
                require(h == r.harness_id, ErrorCode::Forbidden)?;
                let targets = self.revocation_targets(&h, &r.device_id);
                let result = self.store.revoke_member(&r, &h)?;
                if matches!(&result, Res::MemberRevoke(response) if response.removed) {
                    for (cid, principal) in targets {
                        if let Some(connection) = self.online.get(&h).map(|o| o.connection.clone())
                        {
                            let event = Envelope {
                                version: 1,
                                request_id: id(),
                                harness_id: Some(h.clone()),
                                body: Some(Body::Event(Event {
                                    operation: Some(event::Operation::RelayConnectionClosed(
                                        RelayConnectionClosed {
                                            connection_id: cid.clone(),
                                        },
                                    )),
                                })),
                                ..Default::default()
                            };
                            self.send(&connection, event, "", Some(principal), &cid);
                        }
                        if let Some(client) = self.clients.get(&cid) {
                            let _ = client.close.send(true);
                        }
                    }
                    self.sync_members(&h)?;
                }
                Ok(Some(result))
            }
            Req::MembershipSnapshot(_) | Req::Unsupported(_) => {
                Err(ErrorCode::UnsupportedOperation)
            }
            op => {
                require(peer == Peer::Mobile, ErrorCode::Forbidden)?;
                let h = env
                    .harness_id
                    .as_deref()
                    .filter(|h| !h.is_empty())
                    .ok_or(ErrorCode::InvalidArgument)?;
                let principal = self.principal(h, cid)?;
                let online = self.online.get(h).ok_or(ErrorCode::HarnessOffline)?;
                require(
                    online.synced == Some(principal.acl_version),
                    ErrorCode::AclNotSynced,
                )?;
                let hc = online.connection.clone();
                validate(&op)?;
                if let Req::SessionUnfollow(r) = &op {
                    let key = (h.to_owned(), r.subscription_id.clone());
                    if let Some(s) = self.subscriptions.get(&key) {
                        require(s.mobile == cid, ErrorCode::Forbidden)?;
                    } else {
                        return Ok(Some(Res::SessionUnfollow(SessionUnfollowResponse {})));
                    }
                }
                if let Req::ApprovalDecide(r) = &op {
                    require(
                        self.subscriptions.values().any(|s| {
                            s.mobile == cid && s.harness == h && s.session == r.session_id
                        }),
                        ErrorCode::Forbidden,
                    )?;
                }
                require(
                    self.routes.values().filter(|r| r.mobile == cid).count() < 128,
                    ErrorCode::ResourceExhausted,
                )?;
                require(
                    !self
                        .routes
                        .values()
                        .any(|r| r.mobile == cid && r.request.request_id == env.request_id),
                    ErrorCode::InvalidArgument,
                )?;
                if let Req::SessionUnfollow(r) = &op {
                    // Mutate only after route validation succeeds. A rejected request
                    // must leave the observer available for a later cleanup request.
                    self.subscriptions
                        .remove(&(h.to_owned(), r.subscription_id.clone()));
                }
                if matches!(op, Req::SessionFollow(_)) {
                    let active = self
                        .subscriptions
                        .values()
                        .filter(|s| s.mobile == cid)
                        .count();
                    let pending = self
                        .routes
                        .values()
                        .filter(|r| r.mobile == cid && matches!(r.operation, Req::SessionFollow(_)))
                        .count();
                    require(active + pending < 64, ErrorCode::ResourceExhausted)?;
                }
                let route_id = id();
                self.routes.insert(
                    route_id.clone(),
                    Route {
                        harness: h.into(),
                        harness_connection: hc.clone(),
                        mobile: cid.into(),
                        request: env.clone(),
                        operation: op,
                        expires: Instant::now() + Duration::from_secs(30),
                    },
                );
                self.send(&hc, env.clone(), &route_id, Some(principal), cid);
                Ok(None)
            }
        }
    }
    /// Principal and connection targets captured before the membership row is
    /// deleted. The event must be attributable to the membership that existed
    /// when the device connected, even though it is already gone after commit.
    fn revocation_targets(&self, h: &str, device_id: &str) -> Vec<(String, Principal)> {
        let Ok(member) = self.store.member(h, device_id) else {
            return Vec::new();
        };
        let Ok(version) = self.store.version(h) else {
            return Vec::new();
        };
        let principal = Principal {
            user_id: member.user,
            device_id: device_id.to_owned(),
            roles: member.roles,
            acl_version: version,
        };
        self.clients
            .iter()
            .filter_map(|(cid, client)| match &client.identity {
                Some(Identity::Mobile(d)) if d == device_id => {
                    Some((cid.clone(), principal.clone()))
                }
                _ => None,
            })
            .collect()
    }
    fn sync_members(&mut self, h: &str) -> Result<()> {
        let Some(online) = self.online.get_mut(h) else {
            return Ok(());
        };
        online.synced = None;
        let cid = online.connection.clone();
        let snapshot = self.store.snapshot(h)?;
        let version = snapshot.acl_version;
        // Superseded acknowledgements cannot reopen the gate.
        self.sync.retain(|_, r| r.harness != h);
        let route = id();
        let request_id = id();
        self.sync.insert(
            route.clone(),
            SyncRoute {
                harness: h.into(),
                connection: cid.clone(),
                version,
                request_id: request_id.clone(),
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        self.send(
            &cid,
            Envelope {
                version: 1,
                request_id,
                harness_id: Some(h.into()),
                body: Some(Body::Request(Request {
                    operation: Some(Req::MembershipSnapshot(snapshot)),
                })),
                ..Default::default()
            },
            &route,
            None,
            "",
        );
        Ok(())
    }
    fn harness_reply(&mut self, cid: &str, route: &str, mut env: Envelope) {
        if let Some(sync) = self.sync.get(route) {
            if sync.connection != cid {
                return;
            }
            let valid = env.reply_to.as_deref() == Some(sync.request_id.as_str())
                && env.harness_id.as_deref() == Some(sync.harness.as_str())
                && matches!(&env.body,Some(Body::Response(Response{operation:Some(Res::MembershipSnapshot(r))})) if r.applied_acl_version==sync.version);
            if valid {
                let sync = self.sync.remove(route).unwrap();
                if self.store.version(&sync.harness).ok() == Some(sync.version)
                    && let Some(online) = self.online.get_mut(&sync.harness)
                {
                    online.synced = Some(sync.version);
                }
            }
            return;
        }
        let Some(r) = self.routes.get(route) else {
            return;
        };
        if r.harness_connection != cid {
            return;
        }
        if env.reply_to.as_deref() != Some(r.request.request_id.as_str())
            || env.harness_id.as_deref() != Some(r.harness.as_str())
            || env.subscription_id.is_some()
        {
            return;
        }
        let valid = match &env.body {
            Some(Body::Error(e)) => {
                ErrorCode::try_from(e.code).is_ok_and(|c| c != ErrorCode::Unspecified)
            }
            Some(Body::Response(rsp)) => rsp
                .operation
                .as_ref()
                .is_some_and(|op| operation_tag(op) == request_tag(&r.operation)),
            _ => false,
        };
        if !valid {
            return;
        }
        let r = self.routes.remove(route).unwrap();
        if let (
            Req::SessionFollow(f),
            Some(Body::Response(Response {
                operation: Some(Res::SessionFollow(result)),
            })),
        ) = (&r.operation, &env.body)
        {
            let key = (r.harness.clone(), result.subscription_id.clone());
            let session = result
                .baseline
                .as_ref()
                .and_then(|b| b.session.as_ref())
                .map(|s| s.session_id.as_str());
            if result.subscription_id.is_empty()
                || result.subscription_id.len() > 128
                || self.subscriptions.contains_key(&key)
                || session != Some(f.session_id.as_str())
            {
                self.fail(&r.mobile, &r.request, ErrorCode::UpstreamIncompatible);
                if let Some(c) = self.clients.get(cid) {
                    let _ = c.close.send(true);
                }
                return;
            }
            self.subscriptions.insert(
                key,
                Subscription {
                    harness: r.harness.clone(),
                    harness_connection: cid.into(),
                    mobile: r.mobile.clone(),
                    session: f.session_id.clone(),
                },
            );
        }
        env.reply_to = Some(r.request.request_id);
        self.send(&r.mobile, env, "", None, "");
    }
    fn harness_event(&mut self, cid: &str, env: Envelope) {
        if env.reply_to.is_some() {
            return;
        }
        let (Some(h), Some(sub)) = (&env.harness_id, &env.subscription_id) else {
            return;
        };
        let key = (h.clone(), sub.clone());
        let Some(s) = self.subscriptions.get(&key) else {
            return;
        };
        if s.harness_connection != cid || self.principal(h, &s.mobile).is_err() {
            return;
        }
        let Some(Body::Event(event)) = &env.body else {
            return;
        };
        let valid = match &event.operation {
            Some(event::Operation::SessionCommitted(e)) => e.session_id == s.session,
            Some(event::Operation::AssistantLiveStart(e)) => e.session_id == s.session,
            Some(event::Operation::AssistantLiveChunk(e)) => e.session_id == s.session,
            Some(event::Operation::AssistantLiveEnd(e)) => e.session_id == s.session,
            Some(event::Operation::AgentStatusChanged(e)) => {
                e.agent.as_ref().is_some_and(|a| a.session_id == s.session)
            }
            Some(event::Operation::InboxChanged(e)) => e.session_id == s.session,
            Some(event::Operation::ApprovalRequest(e)) => e.session_id == s.session,
            Some(event::Operation::ApprovalResolved(e)) => e.session_id == s.session,
            Some(event::Operation::SubscriptionReset(e)) => e.subscription_id == *sub,
            _ => false,
        };
        if valid {
            let mobile = s.mobile.clone();
            let reset = matches!(
                event.operation,
                Some(event::Operation::SubscriptionReset(_))
            );
            self.send(&mobile, env, "", None, "");
            if reset {
                self.subscriptions.remove(&key);
            }
        }
    }
    pub fn disconnect(&mut self, cid: &str) {
        let Some(client) = self.clients.remove(cid) else {
            return;
        };
        if let Some(Identity::Harness(h)) = client.identity {
            if self.online.get(&h).is_some_and(|o| o.connection == cid) {
                self.online.remove(&h);
            }
            let keys: Vec<_> = self
                .routes
                .iter()
                .filter(|(_, r)| r.harness_connection == cid)
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys {
                let r = self.routes.remove(&key).unwrap();
                self.fail(&r.mobile, &r.request, ErrorCode::HarnessOffline);
            }
            let keys: Vec<_> = self
                .subscriptions
                .iter()
                .filter(|(_, s)| s.harness_connection == cid)
                .map(|(k, _)| k.clone())
                .collect();
            for (h, sub) in keys {
                let s = self
                    .subscriptions
                    .remove(&(h.clone(), sub.clone()))
                    .unwrap();
                self.reset(&s.mobile, &h, &sub);
            }
            self.sync.retain(|_, r| r.connection != cid);
        } else {
            // Notify all Harness memberships: invalidates pending approvals, even without a follow.
            let targets: Vec<_> = self
                .online
                .iter()
                .filter_map(|(h, o)| {
                    self.principal_for_disconnected(h, &client.identity)
                        .map(|p| (h.clone(), o.connection.clone(), p))
                })
                .collect();
            for (h, hc, p) in targets {
                let env = Envelope {
                    version: 1,
                    request_id: id(),
                    harness_id: Some(h),
                    body: Some(Body::Event(Event {
                        operation: Some(event::Operation::RelayConnectionClosed(
                            RelayConnectionClosed {
                                connection_id: cid.into(),
                            },
                        )),
                    })),
                    ..Default::default()
                };
                self.send(&hc, env, "", Some(p), cid);
            }
            self.routes.retain(|_, r| r.mobile != cid);
            self.subscriptions.retain(|_, s| s.mobile != cid);
        }
    }
    fn principal_for_disconnected(
        &self,
        h: &str,
        identity: &Option<Identity>,
    ) -> Option<Principal> {
        let Some(Identity::Mobile(d)) = identity else {
            return None;
        };
        let m = self.store.member(h, d).ok()?;
        Some(Principal {
            user_id: m.user,
            device_id: d.clone(),
            roles: m.roles,
            acl_version: self.store.version(h).ok()?,
        })
    }
    fn reset(&self, m: &str, h: &str, sub: &str) {
        self.send(
            m,
            Envelope {
                version: 1,
                request_id: id(),
                harness_id: Some(h.into()),
                subscription_id: Some(sub.into()),
                body: Some(Body::Event(Event {
                    operation: Some(event::Operation::SubscriptionReset(SubscriptionReset {
                        subscription_id: sub.into(),
                        reason: "Harness connection lost; follow again".into(),
                    })),
                })),
                ..Default::default()
            },
            "",
            None,
            "",
        );
    }
    pub fn sweep(&mut self) {
        let keys: Vec<_> = self
            .routes
            .iter()
            .filter(|(_, r)| r.expires <= Instant::now())
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let r = self.routes.remove(&key).unwrap();
            self.fail(&r.mobile, &r.request, ErrorCode::SubscriptionResetRequired);
            if matches!(r.operation, Req::SessionFollow(_))
                && let Some(c) = self.clients.get(&r.mobile)
            {
                let _ = c.close.send(true);
            }
        }
        let failed: Vec<_> = self
            .sync
            .iter()
            .filter(|(_, r)| r.expires <= Instant::now())
            .map(|(_, r)| r.connection.clone())
            .collect();
        for cid in failed {
            if let Some(c) = self.clients.get(&cid) {
                let _ = c.close.send(true);
            }
        }
        for c in self.clients.values() {
            if c.expires <= now() {
                let _ = c.close.send(true);
            }
        }
        self.attempts
            .retain(|_, (start, _)| start.elapsed() < Duration::from_secs(60));
    }
    pub fn shutdown(&self) {
        for c in self.clients.values() {
            let _ = c.close.send(true);
        }
    }
}
// Prost oneof field tags are the canonical operation identifier.
fn operation_tag(op: &Res) -> u64 {
    let bytes = Response {
        operation: Some(op.clone()),
    }
    .encode_to_vec();
    prost::encoding::decode_varint(&mut bytes.as_slice()).expect("encoded tag") >> 3
}
fn request_tag(op: &Req) -> u64 {
    let bytes = Request {
        operation: Some(op.clone()),
    }
    .encode_to_vec();
    prost::encoding::decode_varint(&mut bytes.as_slice()).expect("encoded tag") >> 3
}
fn mutation(m: &Option<Mutation>) -> Result<()> {
    require(
        m.as_ref().is_some_and(|m| {
            !m.client_operation_id.is_empty() && m.client_operation_id.len() <= 128
        }),
        ErrorCode::InvalidArgument,
    )
}
fn session(s: &str) -> Result<()> {
    require(!s.is_empty() && s.len() <= 128, ErrorCode::InvalidArgument)
}
fn page(n: u32) -> Result<()> {
    require(n <= 200, ErrorCode::InvalidArgument)
}
fn validate(op: &Req) -> Result<()> {
    match op {
        Req::CapabilitiesGet(_) => Ok(()),
        Req::SessionList(r) => page(r.page_size),
        Req::SessionCreate(r) => mutation(&r.mutation),
        Req::SessionOpen(r) => {
            session(&r.session_id)?;
            if r.resume_agent {
                mutation(&r.mutation)
            } else {
                Ok(())
            }
        }
        Req::SessionSnapshot(r) => {
            session(&r.session_id)?;
            page(r.tail_limit)
        }
        Req::SessionPage(r) => {
            session(&r.session_id)?;
            page(r.page_size)
        }
        Req::SessionFollow(r) => {
            session(&r.session_id)?;
            page(r.tail_limit)
        }
        Req::SessionUnfollow(r) => session(&r.subscription_id),
        Req::AgentSend(r) => {
            session(&r.session_id)?;
            session(&r.message_id)?;
            mutation(&r.mutation)?;
            require(
                matches!(r.mode, 1..=3)
                    && !r.content.is_empty()
                    && r.content.iter().all(|b| b.value.is_some()),
                ErrorCode::InvalidArgument,
            )
        }
        Req::AgentInboxGet(r) => session(&r.session_id),
        Req::AgentCancel(r) => {
            session(&r.session_id)?;
            mutation(&r.mutation)
        }
        Req::AgentStatus(r) => session(&r.session_id),
        Req::AgentCreateOrResume(r) => {
            session(&r.session_id)?;
            mutation(&r.mutation)
        }
        Req::ApprovalDecide(r) => {
            session(&r.session_id)?;
            session(&r.approval_id)?;
            mutation(&r.mutation)?;
            require(
                matches!(r.decision, 1 | 2) && r.decision_token.len() == 32,
                ErrorCode::InvalidArgument,
            )
        }
        Req::ApprovalPending(r) => session(&r.session_id),
        Req::ApprovalPolicyGet(r) => session(&r.session_id),
        Req::ApprovalPolicySet(r) => {
            session(&r.session_id)?;
            mutation(&r.mutation)?;
            require(matches!(r.policy, 1 | 2), ErrorCode::InvalidArgument)
        }
        Req::ModelCurrent(r) => session(&r.session_id),
        Req::ModelList(r) => session(&r.session_id),
        Req::ModelSelect(r) => {
            session(&r.session_id)?;
            mutation(&r.mutation)?;
            require(
                r.selection
                    .as_ref()
                    .is_some_and(|m| !m.provider.is_empty() && !m.model.is_empty()),
                ErrorCode::InvalidArgument,
            )
        }
        _ => Err(ErrorCode::UnsupportedOperation),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Endpoint {
        id: String,
        rx: mpsc::Receiver<Vec<u8>>,
        closed: watch::Receiver<bool>,
    }
    fn endpoint(hub: &mut Hub, peer: Peer, identity: Identity) -> Endpoint {
        let (tx, rx) = mpsc::channel(64);
        let (close, closed) = watch::channel(false);
        let cid = hub
            .connect(peer, false, "127.0.0.1".parse().unwrap(), tx, close)
            .unwrap();
        hub.clients.get_mut(&cid).unwrap().identity = Some(identity);
        Endpoint {
            id: cid,
            rx,
            closed,
        }
    }
    fn fixture() -> (Hub, Endpoint, Endpoint) {
        let store = Store::open(":memory:").unwrap();
        store
            .0
            .execute_batch(
                "INSERT INTO harnesses VALUES ('h',X'00','test',1);
          INSERT INTO devices VALUES ('d','u',X'00');
          INSERT INTO members VALUES ('h','d',1);",
            )
            .unwrap();
        let mut hub = Hub::new(store).unwrap();
        let harness = endpoint(&mut hub, Peer::Harness, Identity::Harness("h".into()));
        let mobile = endpoint(&mut hub, Peer::Mobile, Identity::Mobile("d".into()));
        hub.online.insert(
            "h".into(),
            Online {
                connection: harness.id.clone(),
                synced: Some(1),
            },
        );
        (hub, harness, mobile)
    }
    fn request(op: Req) -> Envelope {
        Envelope {
            version: 1,
            request_id: id(),
            harness_id: Some("h".into()),
            body: Some(Body::Request(Request {
                operation: Some(op),
            })),
            ..Default::default()
        }
    }
    fn forward(hub: &mut Hub, mobile: &Endpoint, harness: &mut Endpoint, op: Req) -> RelayForward {
        hub.receive(&mobile.id, &request(op).encode_to_vec())
            .unwrap();
        RelayForward::decode(harness.rx.try_recv().unwrap().as_slice()).unwrap()
    }
    fn reply(hub: &mut Hub, harness: &str, forward: &RelayForward, op: Res) {
        let env = response(forward.envelope.as_ref().unwrap(), op);
        hub.receive(
            harness,
            &HarnessForward {
                route_id: forward.route_id.clone(),
                envelope: Some(env),
            }
            .encode_to_vec(),
        )
        .unwrap();
    }
    fn follow_response() -> Res {
        Res::SessionFollow(SessionFollowResponse {
            subscription_id: "sub".into(),
            baseline: Some(Baseline {
                session: Some(SessionSummary {
                    session_id: "s".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        })
    }
    fn event() -> Envelope {
        Envelope {
            version: 1,
            request_id: id(),
            harness_id: Some("h".into()),
            subscription_id: Some("sub".into()),
            body: Some(Body::Event(Event {
                operation: Some(event::Operation::AssistantLiveChunk(AssistantLiveChunk {
                    session_id: "s".into(),
                    attempt_id: "attempt".into(),
                    ..Default::default()
                })),
            })),
            ..Default::default()
        }
    }
    #[test]
    fn member_revoke_closes_device_and_pushes_fresh_snapshot() {
        let (mut hub, mut harness, mobile) = fixture();
        let op = Req::MemberRevoke(MemberRevokeRequest {
            mutation: Some(Mutation {
                client_operation_id: "revoke-d".into(),
            }),
            harness_id: "h".into(),
            device_id: "d".into(),
        });
        hub.receive(
            &harness.id,
            &HarnessForward {
                route_id: String::new(),
                envelope: Some(request(op)),
            }
            .encode_to_vec(),
        )
        .unwrap();
        assert!(*mobile.closed.borrow());
        assert!(hub.store.member("h", "d").is_err());
        assert_eq!(hub.store.version("h").unwrap(), 2);
        let mut events = 0;
        let mut snapshots = 0;
        let mut revoked = false;
        while let Ok(bytes) = harness.rx.try_recv() {
            let forward = RelayForward::decode(bytes.as_slice()).unwrap();
            match forward.envelope.unwrap().body.unwrap() {
                Body::Event(event) => {
                    if let Some(event::Operation::RelayConnectionClosed(closed)) = event.operation {
                        assert_eq!(closed.connection_id, mobile.id);
                        events += 1;
                    }
                }
                Body::Request(request) => {
                    if let Some(Req::MembershipSnapshot(snapshot)) = request.operation {
                        assert!(snapshot.members.is_empty());
                        snapshots += 1;
                    }
                }
                Body::Response(response) => {
                    if let Some(Res::MemberRevoke(result)) = response.operation {
                        assert!(result.removed);
                        assert_eq!(result.acl_version, 2);
                        revoked = true;
                    }
                }
                _ => {}
            }
        }
        assert_eq!(events, 1);
        assert_eq!(snapshots, 1);
        assert!(revoked);
    }
    #[test]
    fn route_rejects_other_harness_and_mismatched_response_type() {
        let (mut hub, mut harness, mut mobile) = fixture();
        let rogue = endpoint(&mut hub, Peer::Harness, Identity::Harness("rogue".into()));
        let forwarded = forward(
            &mut hub,
            &mobile,
            &mut harness,
            Req::SessionList(SessionListRequest::default()),
        );
        // Field 18 and field 34 have the same first varint byte. Compare the full tag.
        reply(
            &mut hub,
            &harness.id,
            &forwarded,
            Res::ModelCurrent(ModelCurrentResponse::default()),
        );
        reply(
            &mut hub,
            &rogue.id,
            &forwarded,
            Res::SessionList(SessionListResponse::default()),
        );
        assert!(mobile.rx.try_recv().is_err());
        assert!(hub.routes.contains_key(&forwarded.route_id));
        reply(
            &mut hub,
            &harness.id,
            &forwarded,
            Res::SessionList(SessionListResponse::default()),
        );
        let env = Envelope::decode(mobile.rx.try_recv().unwrap().as_slice()).unwrap();
        assert_eq!(env.reply_to, Some(forwarded.envelope.unwrap().request_id));
        assert!(hub.routes.is_empty());
    }
    #[test]
    fn follow_baseline_precedes_events_and_unfollow_stops_immediately() {
        let (mut hub, mut harness, mut mobile) = fixture();
        let forwarded = forward(
            &mut hub,
            &mobile,
            &mut harness,
            Req::SessionFollow(SessionFollowRequest {
                session_id: "s".into(),
                tail_limit: 0,
            }),
        );
        hub.harness_event(&harness.id, event());
        assert!(mobile.rx.try_recv().is_err());
        reply(&mut hub, &harness.id, &forwarded, follow_response());
        hub.harness_event(&harness.id, event());
        let baseline = Envelope::decode(mobile.rx.try_recv().unwrap().as_slice()).unwrap();
        let live = Envelope::decode(mobile.rx.try_recv().unwrap().as_slice()).unwrap();
        assert!(matches!(baseline.body, Some(Body::Response(_))));
        assert!(matches!(live.body, Some(Body::Event(_))));
        forward(
            &mut hub,
            &mobile,
            &mut harness,
            Req::SessionUnfollow(SessionUnfollowRequest {
                subscription_id: "sub".into(),
            }),
        );
        hub.harness_event(&harness.id, event());
        assert!(mobile.rx.try_recv().is_err());
        assert!(hub.subscriptions.is_empty());
    }
    #[test]
    fn stale_acl_acknowledgement_cannot_open_business_gate() {
        let (mut hub, mut harness, mobile) = fixture();
        hub.sync_members("h").unwrap();
        let old = RelayForward::decode(harness.rx.try_recv().unwrap().as_slice()).unwrap();
        hub.store
            .0
            .execute("UPDATE harnesses SET acl_version=2 WHERE id='h'", [])
            .unwrap();
        hub.sync_members("h").unwrap();
        let new = RelayForward::decode(harness.rx.try_recv().unwrap().as_slice()).unwrap();
        reply(
            &mut hub,
            &harness.id,
            &old,
            Res::MembershipSnapshot(MembershipSnapshotResponse {
                applied_acl_version: 1,
            }),
        );
        assert_eq!(hub.online["h"].synced, None);
        assert_eq!(
            hub.request(
                &mobile.id,
                &request(Req::SessionList(SessionListRequest::default())),
                Req::SessionList(SessionListRequest::default())
            ),
            Err(ErrorCode::AclNotSynced)
        );
        reply(
            &mut hub,
            &harness.id,
            &new,
            Res::MembershipSnapshot(MembershipSnapshotResponse {
                applied_acl_version: 2,
            }),
        );
        assert_eq!(hub.online["h"].synced, Some(2));
    }
    #[test]
    fn bounded_outbound_queue_disconnects_slow_consumer() {
        let (hub, _, mobile) = fixture();
        for _ in 0..65 {
            hub.send(&mobile.id, event(), "", None, "");
        }
        assert!(*mobile.closed.borrow());
        assert_eq!(mobile.rx.len(), 64);
    }
    #[test]
    fn pending_follow_timeout_closes_connection_to_release_harness_state() {
        let (mut hub, mut harness, mobile) = fixture();
        let forwarded = forward(
            &mut hub,
            &mobile,
            &mut harness,
            Req::SessionFollow(SessionFollowRequest {
                session_id: "s".into(),
                tail_limit: 0,
            }),
        );
        hub.routes.get_mut(&forwarded.route_id).unwrap().expires = Instant::now();
        hub.sweep();
        assert!(*mobile.closed.borrow());
        hub.disconnect(&mobile.id);
        let cleanup = RelayForward::decode(harness.rx.try_recv().unwrap().as_slice()).unwrap();
        assert_eq!(cleanup.connection_id, mobile.id);
        assert!(matches!(
            cleanup.envelope.unwrap().body,
            Some(Body::Event(Event {
                operation: Some(event::Operation::RelayConnectionClosed(_))
            }))
        ));
    }
    #[test]
    fn rejected_unfollow_does_not_orphan_harness_subscription() {
        let (mut hub, mut harness, mut mobile) = fixture();
        let follow = forward(
            &mut hub,
            &mobile,
            &mut harness,
            Req::SessionFollow(SessionFollowRequest {
                session_id: "s".into(),
                tail_limit: 0,
            }),
        );
        reply(&mut hub, &harness.id, &follow, follow_response());
        mobile.rx.try_recv().unwrap();
        for _ in 0..128 {
            forward(
                &mut hub,
                &mobile,
                &mut harness,
                Req::SessionList(SessionListRequest::default()),
            );
        }
        let unfollow = request(Req::SessionUnfollow(SessionUnfollowRequest {
            subscription_id: "sub".into(),
        }));
        hub.receive(&mobile.id, &unfollow.encode_to_vec()).unwrap();
        let env = Envelope::decode(mobile.rx.try_recv().unwrap().as_slice()).unwrap();
        assert!(
            matches!(env.body, Some(Body::Error(ProtocolError { code, .. })) if code == ErrorCode::ResourceExhausted as i32)
        );
        assert!(
            hub.subscriptions
                .contains_key(&(String::from("h"), String::from("sub")))
        );
    }
    #[test]
    fn authentication_and_business_have_separate_rate_buckets() {
        let (mut hub, _, _) = fixture();
        let ip = "127.0.0.1".parse().unwrap();
        for _ in 0..200 {
            assert!(hub.rate(ip, true, 2400));
        }
        assert!(hub.rate(ip, false, 120));
    }
}
