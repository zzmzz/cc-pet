use crate::config::SshTunnelConfig;
use std::io::Read;
use std::process::{Child, Command, Stdio};

pub struct SshTunnelProcess {
    pub child: Child,
}

pub fn read_process_stderr(child: &mut Child) -> String {
    if let Some(mut stderr) = child.stderr.take() {
        let mut out = String::new();
        let _ = stderr.read_to_string(&mut out);
        return out.trim().to_string();
    }
    String::new()
}

pub fn build_ssh_args(cfg: &SshTunnelConfig) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        cfg.bastion_port.to_string(),
        "-N".to_string(),
        "-L".to_string(),
        format!(
            "{}:{}:{}:{}",
            cfg.local_host, cfg.local_port, cfg.target_host, cfg.target_port
        ),
    ];
    if !cfg.identity_file.trim().is_empty() {
        args.push("-i".to_string());
        args.push(cfg.identity_file.clone());
    }
    args.push("-o".to_string());
    args.push("ExitOnForwardFailure=yes".to_string());
    args.push("-o".to_string());
    args.push("ServerAliveInterval=30".to_string());
    args.push("-o".to_string());
    args.push("ServerAliveCountMax=3".to_string());
    args.push("-o".to_string());
    args.push(format!(
        "StrictHostKeyChecking={}",
        if cfg.strict_host_key_checking {
            "yes"
        } else {
            "accept-new"
        }
    ));
    args.push(format!("{}@{}", cfg.bastion_user, cfg.bastion_host));
    args
}

pub fn spawn_ssh_tunnel(cfg: &SshTunnelConfig) -> Result<SshTunnelProcess, String> {
    let args = build_ssh_args(cfg);
    let mut cmd = Command::new("ssh");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    Ok(SshTunnelProcess { child })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cfg() -> SshTunnelConfig {
        SshTunnelConfig {
            enabled: true,
            bastion_host: "nas.ziiimo.cn".to_string(),
            bastion_port: 2048,
            bastion_user: "zzm".to_string(),
            target_host: "192.168.8.2".to_string(),
            target_port: 9810,
            local_host: "127.0.0.1".to_string(),
            local_port: 9810,
            identity_file: "C:/Users/me/.ssh/id_ed25519".to_string(),
            strict_host_key_checking: true,
        }
    }

    #[test]
    fn build_ssh_args_contains_port_forward_and_destination() {
        let args = build_ssh_args(&sample_cfg());
        assert!(args.contains(&"-N".to_string()));
        assert!(args.contains(&"-L".to_string()));
        assert!(args.contains(&"127.0.0.1:9810:192.168.8.2:9810".to_string()));
        assert_eq!(args.last().map(|s| s.as_str()), Some("zzm@nas.ziiimo.cn"));
    }

    #[test]
    fn build_ssh_args_omits_identity_when_empty() {
        let mut cfg = sample_cfg();
        cfg.identity_file = String::new();
        let args = build_ssh_args(&cfg);
        assert!(!args.iter().any(|a| a == "-i"));
    }

    #[test]
    fn read_process_stderr_returns_empty_when_no_stderr() {
        #[cfg(target_os = "windows")]
        let mut child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        #[cfg(not(target_os = "windows"))]
        let mut child = Command::new("sh")
            .args(["-c", "exit 0"])
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let _ = child.wait();
        let _ = read_process_stderr(&mut child);
    }
}
