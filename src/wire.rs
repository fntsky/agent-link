#[allow(dead_code)] // Shared contract also contains types used only by endpoints.
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/hrp.v1.rs"));
}
use ed25519_dalek::{Signature, VerifyingKey};
pub use pb::{envelope::Body, request::Operation as Req, response::Operation as Res, *};
use rand::RngCore;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_FRAME: usize = 1024 * 1024;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
pub fn timestamp(seconds: i64) -> prost_types::Timestamp {
    prost_types::Timestamp { seconds, nanos: 0 }
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn random_bytes() -> Vec<u8> {
    let mut data = vec![0; 32];
    rand::rngs::OsRng.fill_bytes(&mut data);
    data
}
pub fn transcript(prefix: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut result = prefix.to_vec();
    for part in parts {
        result.extend_from_slice(&(part.len() as u32).to_be_bytes());
        result.extend_from_slice(part);
    }
    result
}
pub fn verify(key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(key): std::result::Result<&[u8; 32], _> = key.try_into() else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(key) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}
pub fn valid_key(key: &[u8]) -> bool {
    key.try_into()
        .ok()
        .and_then(|k| VerifyingKey::from_bytes(k).ok())
        .is_some_and(|k| !k.is_weak())
}
pub fn response(request: &Envelope, operation: Res) -> Envelope {
    Envelope {
        version: 1,
        request_id: id(),
        reply_to: Some(request.request_id.clone()),
        harness_id: request.harness_id.clone(),
        body: Some(Body::Response(Response {
            operation: Some(operation),
        })),
        ..Default::default()
    }
}
pub fn error(request: &Envelope, code: ErrorCode) -> Envelope {
    Envelope {
        version: 1,
        request_id: id(),
        reply_to: Some(request.request_id.clone()),
        harness_id: request.harness_id.clone(),
        body: Some(Body::Error(ProtocolError {
            code: code as i32,
            message: code.as_str_name().to_owned(),
            retryable: matches!(code, ErrorCode::HarnessOffline | ErrorCode::AclNotSynced),
        })),
        ..Default::default()
    }
}
pub type Result<T> = std::result::Result<T, ErrorCode>;
pub fn require(condition: bool, code: ErrorCode) -> Result<()> {
    if condition { Ok(()) } else { Err(code) }
}
