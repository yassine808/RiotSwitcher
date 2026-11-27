"""Minimal Tkinter shell: the Python-language baseline for the same content."""
import tkinter as tk

root = tk.Tk()
root.title("shell benchmark")
root.geometry("1100x790")
root.configure(bg="#0e1620")

frame = tk.Frame(root, bg="#0e1620", padx=40, pady=40)
frame.pack(fill="both", expand=True)

tk.Label(frame, text="RiotSwitcher shell benchmark", fg="#eef3fa", bg="#0e1620",
         font=("Segoe UI", 20, "bold")).pack(anchor="w")
tk.Button(frame, text="Switch account", padx=14, pady=6).pack(anchor="w", pady=12)
for i in range(1, 9):
    tk.Label(frame, text=f"Profile {i}", fg="#eef3fa", bg="#0e1620",
             font=("Segoe UI", 10)).pack(anchor="w", pady=3)

root.mainloop()
