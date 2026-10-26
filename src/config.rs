use anyhow::Context;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub fn registration_token(explicit: Option<String>, path: Option<&Path>) -> anyhow::Result<String> {
    let token = if let Some(token) = explicit {
        token
    } else {
        let path = path.context("set HRP_REGISTRATION_TOKEN or HRP_REGISTRATION_TOKEN_FILE")?;
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).context("cannot create registration token directory")?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(mut file) => {
                writeln!(file, "{}", hex::encode(crate::wire::random_bytes()))
                    .context("cannot save registration token")?;
                file.sync_all().context("cannot sync registration token")?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => anyhow::bail!("cannot create registration token file"),
        }
        eprintln!("registration token file: {}", path.display());
        fs::read_to_string(path)
            .context("cannot read registration token file")?
            .trim()
            .to_owned()
    };
    anyhow::ensure!(
        token.len() >= 32,
        "HRP registration token must contain at least 32 bytes"
    );
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_token_is_private_and_survives_restarts() {
        let directory = std::env::temp_dir().join(format!("hrp-config-{}", crate::wire::id()));
        let path = directory.join("relay-registration-token");
        let first = registration_token(None, Some(&path)).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(first, registration_token(None, Some(&path)).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let explicit = "explicit-registration-token-that-is-long-enough".to_owned();
        assert_eq!(
            explicit,
            registration_token(Some(explicit.clone()), Some(&path)).unwrap()
        );
        assert_eq!(first, registration_token(None, Some(&path)).unwrap());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn invalid_existing_token_is_not_silently_replaced() {
        let directory = std::env::temp_dir().join(format!("hrp-config-{}", crate::wire::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("relay-registration-token");
        fs::write(&path, "invalid").unwrap();
        assert!(registration_token(None, Some(&path)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "invalid");
        assert!(registration_token(None, None).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
