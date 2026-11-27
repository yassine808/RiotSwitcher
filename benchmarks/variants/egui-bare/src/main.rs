#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> eframe::Result<()> {
    eframe::run_ui_native(
        "shell benchmark",
        eframe::NativeOptions::default(),
        |ui, _frame| {
            ui.heading("RiotSwitcher shell benchmark");
            if ui.button("Switch account").clicked() {}
            for i in 1..=8 {
                ui.label(format!("Profile {i}"));
            }
        },
    )
}
