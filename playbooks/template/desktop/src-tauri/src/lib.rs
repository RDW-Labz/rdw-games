/// Opens the OASIS shell window. T01 registers no commands and no plugins.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// T01 ships a shell, not an installer, and asks for no permissions.
    #[test]
    fn config_ships_no_installer_and_no_permissions() {
        let raw = include_str!("../tauri.conf.json");
        let config: Value = serde_json::from_str(raw).expect("tauri.conf.json parses");

        assert_eq!(config["bundle"]["active"], Value::Bool(false));
        assert_eq!(
            config["app"]["security"]["capabilities"],
            Value::Array(Vec::new())
        );
    }
}
