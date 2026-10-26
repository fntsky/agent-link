mod relay;
mod store;
mod wire;

use axum::{
    Router,
    extract::{
        ConnectInfo, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use relay::{Hub, Peer};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc, watch};

#[derive(Clone)]
struct App {
    hub: Arc<Mutex<Hub>>,
    registration_hash: [u8; 32],
}
// Log only known paths/status; never headers, query strings or payloads.
async fn access_log(request: axum::extract::Request, next: Next) -> Response {
    let path = match request.uri().path() {
        "/healthz" => "/healthz",
        "/ws/mobile" => "/ws/mobile",
        "/ws/harness" => "/ws/harness",
        _ => "<other>",
    };
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0);
    let response = next.run(request).await;
    eprintln!(
        "http peer={peer:?} path={path} status={}",
        response.status().as_u16()
    );
    response
}
async fn mobile(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    upgrade(app, addr, headers, ws, Peer::Mobile)
}
async fn harness(
    State(app): State<App>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    upgrade(app, addr, headers, ws, Peer::Harness)
}
fn upgrade(
    app: App,
    addr: SocketAddr,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    peer: Peer,
) -> Response {
    let protocol = if peer == Peer::Mobile {
        "hrp.pb.v1"
    } else {
        "hrp.relay.pb.v1"
    };
    let offered = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|v| v.trim() == protocol));
    if !offered {
        eprintln!("ws handshake_rejected peer={addr} reason=missing_subprotocol");
        return (
            StatusCode::BAD_REQUEST,
            "required HRP WebSocket subprotocol missing",
        )
            .into_response();
    }
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    let supplied: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let registration = !token.is_empty() && supplied == app.registration_hash;
    ws.protocols([protocol])
        .max_message_size(wire::MAX_FRAME)
        .max_frame_size(wire::MAX_FRAME)
        .on_upgrade(move |socket| connection(app, socket, peer, registration, addr))
}
async fn connection(app: App, socket: WebSocket, peer: Peer, registration: bool, addr: SocketAddr) {
    let (tx, mut rx) = mpsc::channel(64);
    let (close, mut cancelled) = watch::channel(false);
    let Some(cid) = app
        .hub
        .lock()
        .await
        .connect(peer, registration, addr.ip(), tx, close)
    else {
        eprintln!("ws connection_rejected peer={addr} reason=capacity_or_rate_limit");
        return;
    };
    eprintln!(
        "ws connected peer={addr} connection={cid} kind={}",
        if peer == Peer::Mobile {
            "mobile"
        } else {
            "harness"
        }
    );
    let mut reason = "peer_closed";
    let (mut sink, mut source) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last_seen = tokio::time::Instant::now();
    loop {
        let outgoing = tokio::select! {
            _=cancelled.changed()=>{reason="server_closed";break},
            _=heartbeat.tick()=>{if last_seen.elapsed()>Duration::from_secs(45){reason="heartbeat_timeout";break} Some(Message::Ping(Vec::new().into()))},
            data=rx.recv()=>data.map(|data|Message::Binary(data.into())),
            incoming=source.next()=>{
                match incoming{
                    Some(Ok(Message::Binary(data)))=>{
                        last_seen=tokio::time::Instant::now();
                        if let Err(code)=app.hub.lock().await.receive(&cid,&data){
                            eprintln!("ws rejected connection={cid} code={}",code.as_str_name());
                            reason="protocol_rejected";break
                        }
                        continue
                    }
                    Some(Ok(Message::Ping(data)))=>{last_seen=tokio::time::Instant::now();Some(Message::Pong(data))}
                    Some(Ok(Message::Pong(_)))=>{last_seen=tokio::time::Instant::now();continue}
                    Some(Ok(Message::Text(_)))=>{reason="text_frame_rejected";break},
                    Some(Err(_))=>{reason="transport_error";break},
                    _=>break,
                }
            }
        };
        let Some(message) = outgoing else { break };
        if !matches!(
            tokio::time::timeout(Duration::from_secs(5), sink.send(message)).await,
            Ok(Ok(()))
        ) {
            reason = "write_failed_or_timeout";
            break;
        }
    }
    eprintln!("ws disconnected peer={addr} connection={cid} reason={reason}");
    app.hub.lock().await.disconnect(&cid);
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let address = std::env::var("HRP_LISTEN").unwrap_or_else(|_| "127.0.0.1:53214".into());
    let database = std::env::var("HRP_DATABASE").unwrap_or_else(|_| "data/relay.sqlite3".into());
    let token = std::env::var("HRP_REGISTRATION_TOKEN")
        .map_err(|_| anyhow::anyhow!("HRP_REGISTRATION_TOKEN must be set (at least 32 bytes)"))?;
    anyhow::ensure!(
        token.len() >= 32,
        "HRP_REGISTRATION_TOKEN must contain at least 32 bytes"
    );
    let app = App {
        hub: Arc::new(Mutex::new(Hub::new(store::Store::open(&database)?)?)),
        registration_hash: Sha256::digest(token.as_bytes()).into(),
    };
    let sweep = app.hub.clone();
    let sweeper = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            sweep.lock().await.sweep();
        }
    });
    let shutdown = app.hub.clone();
    let router = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws/mobile", get(mobile))
        .route("/ws/harness", get(harness))
        .layer(middleware::from_fn(access_log))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(&address).await?;
    eprintln!("dsh-remote listening on {}", listener.local_addr()?);
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        shutdown.lock().await.shutdown();
    })
    .await;
    sweeper.abort();
    result?;
    Ok(())
}
