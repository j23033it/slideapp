fn main() {
    let attributes = tauri_build::Attributes::new().windows_attributes(
        // Tauri の既定マニフェストは bin にしかリンクされず、`cargo test` の
        // テストバイナリが Common Controls v6 を見つけられない。
        // ここではマニフェストを自前で全ターゲットにリンクする。
        // https://github.com/tauri-apps/tauri/issues/13419
        tauri_build::WindowsAttributes::new_without_app_manifest(),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile_for_everything(
            "windows-app-manifest.rc",
            embed_resource::NONE,
        )
        .manifest_required()
        .expect("failed to compile the Windows manifest");
    }
}
