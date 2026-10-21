use std::fs::File;
use std::time::Duration;

use zos_photostaff::command::{CommandLimits, CommandRunner, child_media_path};

fn limits() -> CommandLimits {
    CommandLimits {
        timeout: Duration::from_secs(2),
        max_stdout_bytes: 1024,
        max_file_bytes: 1024 * 1024,
        max_address_space_bytes: 4 * 1024 * 1024 * 1024,
    }
}

#[tokio::test]
async fn fake_tool_reads_the_open_source_descriptor_after_path_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.jpg");
    std::fs::write(&source_path, b"original bytes").unwrap();
    let source = File::open(&source_path).unwrap();
    let replacement = directory.path().join("replacement.jpg");
    std::fs::write(&replacement, b"replacement bytes").unwrap();
    std::fs::rename(&replacement, &source_path).unwrap();

    let output = CommandRunner
        .run(
            "sh",
            &["-c".into(), format!("cat {}", child_media_path())],
            Some(&source),
            &limits(),
        )
        .await
        .unwrap();

    assert_eq!(output.stdout, b"original bytes");
    assert_eq!(std::fs::read(source_path).unwrap(), b"replacement bytes");
}

#[tokio::test]
async fn fake_tool_crashes_are_retryable_but_media_rejections_are_not() {
    let crashed = CommandRunner
        .run(
            "sh",
            &["-c".into(), "kill -SEGV $$".into()],
            None,
            &limits(),
        )
        .await
        .unwrap_err();
    let rejected = CommandRunner
        .run("sh", &["-c".into(), "exit 2".into()], None, &limits())
        .await
        .unwrap_err();

    assert!(crashed.retryable);
    assert!(!rejected.retryable);
}
