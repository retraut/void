//! void-agent — auto-detect project type
//!
//! If build_command / serve_command are not provided, scan the cloned repo
//! for known markers and produce sensible defaults. This is the "Railpack-lite"
//! path — zero-config deploys for common stacks.

use std::path::Path;

/// Result of auto-detect: optional build + serve commands, and a port to listen on.
#[derive(Debug, Clone, Default)]
pub struct Detected {
    pub framework: String,        // e.g. "node", "python", "go", "static", "unknown"
    pub build_command: Option<String>,
    pub serve_command: Option<String>,
    pub port: u16,
}

/// Detect project type from a cloned directory. Returns a Detected struct
/// with framework, optional build/serve commands, and port. Conservative —
/// only returns commands when confident.
pub fn detect(build_dir: &Path) -> Detected {
    // Priority: Node > Python > Go > Rust > Makefile > static

    // Node.js: package.json
    let pkg = build_dir.join("package.json");
    if pkg.exists() {
        return detect_node(build_dir, &pkg);
    }

    // Python: requirements.txt / pyproject.toml
    if build_dir.join("requirements.txt").exists()
        || build_dir.join("pyproject.toml").exists()
    {
        return detect_python(build_dir);
    }

    // Go: go.mod
    if build_dir.join("go.mod").exists() {
        return Detected {
            framework: "go".into(),
            build_command: Some("go build -o app .".into()),
            serve_command: Some("./app".into()),
            port: 8080,
        };
    }

    // Rust: Cargo.toml
    if build_dir.join("Cargo.toml").exists() {
        return Detected {
            framework: "rust".into(),
            build_command: Some("cargo build --release".into()),
            serve_command: None, // user must override; we don't know the binary name
            port: 8080,
        };
    }

    // Makefile
    if build_dir.join("Makefile").exists() || build_dir.join("makefile").exists() {
        return Detected {
            framework: "make".into(),
            build_command: Some("make".into()),
            serve_command: None,
            port: 8080,
        };
    }

    // Fallback: static site
    Detected {
        framework: "static".into(),
        build_command: None,
        serve_command: Some("python3 -m http.server 8000".into()),
        port: 8000,
    }
}

fn detect_node(_build_dir: &Path, pkg: &Path) -> Detected {
    let raw = std::fs::read_to_string(pkg).unwrap_or_default();
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => {
            return Detected {
                framework: "node".into(),
                build_command: Some("npm install --no-audit --omit=dev".into()),
                serve_command: Some("node index.js".into()),
                port: 3000,
            };
        }
    };

    let has_start = v
        .get("scripts")
        .and_then(|s| s.get("start"))
        .and_then(|s| s.as_str())
        .is_some();
    let has_build = v
        .get("scripts")
        .and_then(|s| s.get("build"))
        .and_then(|s| s.as_str())
        .is_some();

    let port = v
        .get("engines")
        .map(|_| 3000)
        .unwrap_or(3000);

    let build_command = if has_build {
        Some("npm install --no-audit --omit=dev && npm run build".into())
    } else {
        Some("npm install --no-audit --omit=dev".into())
    };

    let serve_command = if has_start {
        Some("npm start".into())
    } else {
        // Try index.js / server.js / app.js
        if _build_dir.join("index.js").exists() {
            Some("node index.js".into())
        } else if _build_dir.join("server.js").exists() {
            Some("node server.js".into())
        } else if _build_dir.join("app.js").exists() {
            Some("node app.js".into())
        } else {
            None
        }
    };

    Detected {
        framework: "node".into(),
        build_command,
        serve_command,
        port,
    }
}

fn detect_python(build_dir: &Path) -> Detected {
    let has_app_py = build_dir.join("app.py").exists();
    let has_main_py = build_dir.join("main.py").exists();
    let has_manage_py = build_dir.join("manage.py").exists(); // Django

    let build_command = if build_dir.join("requirements.txt").exists() {
        Some("pip install -r requirements.txt --quiet".into())
    } else {
        None
    };

    let (serve_command, port) = if has_manage_py {
        ("python3 manage.py runserver 0.0.0.0:8000".to_string(), 8000)
    } else if has_app_py {
        // Check if requirements has gunicorn
        let reqs = build_dir.join("requirements.txt");
        let uses_gunicorn = std::fs::read_to_string(&reqs)
            .unwrap_or_default()
            .to_lowercase()
            .contains("gunicorn");
        if uses_gunicorn {
            ("gunicorn app:app --bind 0.0.0.0:8000 --workers 2".to_string(), 8000)
        } else {
            ("python3 app.py".to_string(), 5000)
        }
    } else if has_main_py {
        ("python3 main.py".to_string(), 5000)
    } else {
        ("python3 -m http.server 8000".to_string(), 8000)
    };

    Detected {
        framework: "python".into(),
        build_command,
        serve_command: Some(serve_command),
        port,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_node_with_start_script() {
        let dir = tempdir();
        fs::write(
            dir.join("package.json"),
            r#"{"name":"x","scripts":{"start":"node index.js"}}"#,
        )
        .unwrap();
        let d = detect(&dir);
        assert_eq!(d.framework, "node");
        assert!(d.serve_command.unwrap().contains("npm start"));
    }

    #[test]
    fn detects_python_with_gunicorn() {
        let dir = tempdir();
        fs::write(dir.join("requirements.txt"), "flask\ngunicorn\n").unwrap();
        fs::write(dir.join("app.py"), "").unwrap();
        let d = detect(&dir);
        assert_eq!(d.framework, "python");
        assert!(d.serve_command.unwrap().contains("gunicorn"));
        assert_eq!(d.port, 8000);
    }

    #[test]
    fn detects_static() {
        let dir = tempdir();
        fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();
        let d = detect(&dir);
        assert_eq!(d.framework, "static");
    }

    fn tempdir() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("void-detect-{}", ulid::Ulid::new()));
        fs::create_dir_all(&p).unwrap();
        p
    }
}
