fn main() -> std::io::Result<()> {
    println!("cargo:rerun-if-changed=proto/hrp/v1/hrp.proto");
    prost_build::compile_protos(&["proto/hrp/v1/hrp.proto"], &["proto"])
}
