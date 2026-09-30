"""Net KeepAlive - keeps the campus internet (captive-portal keepalive page) logged in.

Opens the portal in Chrome, logs in with the credentials typed into the window, leaves the
keepalive page open and logs in again every few hours. The portal URL is read from (and saved
back to) D:\\url_home.txt so it survives restarts, and can be changed from the window at any time.
"""

import ctypes
import json
import os
import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk
from urllib.parse import urlparse

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By

APP_NAME = "NetKeepAlive"
DEFAULT_URL_FILE = r"D:\url_home.txt"
DEFAULT_URL = "http://192.168.249.1:1000/keepalive?0805060d04020b07"
DEFAULT_RELOGIN_HOURS = 9

SETTINGS_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), APP_NAME)
SETTINGS_FILE = os.path.join(SETTINGS_DIR, "settings.json")
# Used when the URL file's drive (e.g. D:) is missing.
FALLBACK_URL_FILE = os.path.join(SETTINGS_DIR, "url_home.txt")


def load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(settings):
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)


def read_url(path):
    """Return (url, file it came from). Tries `path`, then the fallback file, then the built-in default."""
    for candidate in (path, FALLBACK_URL_FILE):
        try:
            with open(candidate, encoding="utf-8-sig") as f:
                url = f.read().strip()
        except OSError:
            continue
        if url:
            return url, candidate
    return DEFAULT_URL, None


def write_url(path, url):
    """Save `url` to `path`, or to the fallback file if that location is unavailable. Returns the file used."""
    for target in (path, FALLBACK_URL_FILE):
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(url)
            return target
        except OSError:
            continue
    return None


def is_valid_url(url):
    parts = urlparse(url)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


class StopSession(Exception):
    """The user stopped the session (or cancelled a prompt)."""


class BrowserClosed(Exception):
    """The Chrome window went away."""


class UrlProblem(Exception):
    """The portal URL could not be opened, or it did not lead to a login form (probably expired)."""


class LoginFailed(Exception):
    """The portal rejected the credentials."""


class KeepAliveWorker(threading.Thread):
    """Drives Chrome: log in, sit on the keepalive page, log in again every `relogin_seconds`.

    Talks to the GUI only through `emit(kind, **data)`; the GUI calls stop / relogin_now / switch_url.
    """

    def __init__(self, username, password, url, relogin_seconds, emit):
        super().__init__(daemon=True)
        self.username = username
        self.password = password
        self.url = url
        self.relogin_seconds = relogin_seconds
        self.emit = emit
        self.driver = None
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()  # set to cut the idle wait short
        self.pending_url = None

    # -- called from the GUI thread ------------------------------------------------------------

    def stop(self):
        self.stop_event.set()

    def relogin_now(self):
        self.wake_event.set()

    def switch_url(self, url):
        self.pending_url = url
        self.wake_event.set()

    def kill_browser(self):
        try:
            self.driver.quit()
        except Exception:
            pass

    # -- worker thread -------------------------------------------------------------------------

    def run(self):
        try:
            self._start_browser()
            target = self.url
            while not self.stop_event.is_set():
                self._establish_session(target)
                self.emit("state", value="online")
                self.emit("status", text="Online - session is being kept alive")
                self.emit("next_login", when=time.time() + self.relogin_seconds)
                self._idle(time.time() + self.relogin_seconds)
                target = self.pending_url
                self.pending_url = None
                if target:
                    self.url = target
        except StopSession:
            pass
        except BrowserClosed:
            if not self.stop_event.is_set():
                self.emit("error", title="Browser closed",
                          text="The Chrome window was closed, so keep-alive has stopped.\n"
                               "Press Start to connect again.")
        except LoginFailed as exc:
            self.emit("error", title="Login failed", text=str(exc))
        except Exception as exc:
            if not self.stop_event.is_set():
                self.emit("error", title="Error", text=f"{type(exc).__name__}: {exc}")
        finally:
            self.kill_browser()
            self.emit("stopped")

    def _chrome_options(self):
        options = webdriver.ChromeOptions()
        options.add_argument("--ignore-ssl-errors=yes")
        options.add_argument("--ignore-certificate-errors")
        options.add_experimental_option("excludeSwitches", ["enable-logging"])
        return options

    def _start_browser(self):
        self.emit("state", value="connecting")
        self.emit("status", text="Starting Chrome...")
        self.driver = webdriver.Chrome(options=self._chrome_options())
        self.driver.set_page_load_timeout(60)

    def _establish_session(self, url):
        """Log in, asking the user for a new URL whenever the current one turns out to be unusable."""
        while True:
            self.emit("state", value="connecting")
            try:
                self._login_cycle(url)
                return
            except UrlProblem as exc:
                self.emit("status", text="Portal URL needs attention")
                url = self._ask_new_url(str(exc))
                if not url:
                    raise StopSession from exc
                self.url = url

    def _login_cycle(self, url):
        d = self.driver
        self.emit("status", text="Connecting...")
        if url:
            self._log(f"Opening {url}")
            self._open(url)

        # Log out of any previous session so the portal shows its login form again.
        try:
            self._wait_for(lambda dr: dr.find_elements(By.LINK_TEXT, "logout"), 5)[0].click()
            self._log("Logged out of the previous session.")
            self._pause(5)
        except TimeoutException:
            self._log("No active session to log out of.")

        d.refresh()
        try:
            self._wait_for(lambda dr: dr.find_elements(By.ID, "ft_un"), 30)
        except TimeoutException:
            raise UrlProblem(f"The login form was not found at:\n{d.current_url}\n\n"
                             "The URL has probably expired. Enter a new one.") from None

        user_field = d.find_element(By.ID, "ft_un")
        pass_field = d.find_element(By.ID, "ft_pd")
        user_field.clear()
        user_field.send_keys(self.username)
        pass_field.clear()
        pass_field.send_keys(self.password)
        self._log("Submitting login...")
        d.find_element(By.CSS_SELECTOR, 'input[type="submit"]').click()

        try:
            self._wait_for(lambda dr: not dr.find_elements(By.ID, "ft_un"), 20)
        except TimeoutException:
            raise LoginFailed("The portal showed the login form again.\n"
                              "Check your username and password.") from None

        try:
            self._wait_for(lambda dr: "keepalive" in dr.current_url, 15)
        except TimeoutException:
            self._log("The portal did not redirect to a keepalive page; saving the current URL anyway.")
        self.url = d.current_url
        self._log("Logged in.")
        self.emit("url_saved", url=self.url)

    def _open(self, url):
        try:
            self.driver.get(url)
        except Exception as exc:
            self._check_browser()
            raise UrlProblem(f"Could not open the portal page:\n{url}\n\n"
                             f"({type(exc).__name__}) Check the network connection and the URL.") from exc

    def _idle(self, deadline):
        """Wait until it is time to log in again, or the user stops / asks for a re-login / a new URL."""
        last_check = time.time()
        while not self.stop_event.is_set() and time.time() < deadline:
            if self.wake_event.wait(0.5):
                self.wake_event.clear()
                return
            if time.time() - last_check > 5:
                self._check_browser()
                last_check = time.time()

    def _ask_new_url(self, reason):
        reply = queue.Queue(maxsize=1)
        self.emit("ask_url", reason=reason, reply=reply)
        while not self.stop_event.is_set():
            try:
                return reply.get(timeout=0.5)
            except queue.Empty:
                pass
        return None

    def _check_browser(self):
        try:
            handles = self.driver.window_handles
        except Exception as exc:
            raise BrowserClosed from exc
        if not handles:
            raise BrowserClosed

    def _wait_for(self, condition, timeout):
        """Poll `condition(driver)` until it is truthy. Stop-aware, unlike WebDriverWait."""
        end = time.time() + timeout
        while True:
            if self.stop_event.is_set():
                raise StopSession
            result = condition(self.driver)
            if result:
                return result
            if time.time() >= end:
                raise TimeoutException()
            time.sleep(0.5)

    def _pause(self, seconds):
        if self.stop_event.wait(seconds):
            raise StopSession

    def _log(self, text):
        self.emit("log", text=text)


class UrlDialog(tk.Toplevel):
    """Modal prompt for a new portal URL. `result` is the URL, or None if cancelled."""

    def __init__(self, parent, message, initial):
        super().__init__(parent)
        self.title("Portal URL")
        self.transient(parent)
        self.resizable(False, False)
        self.result = None

        ttk.Label(self, text=message, wraplength=520, justify="left").grid(
            row=0, column=0, padx=12, pady=(12, 6), sticky="w")
        self.var = tk.StringVar(value=initial)
        entry = ttk.Entry(self, textvariable=self.var, width=70)
        entry.grid(row=1, column=0, padx=12, sticky="ew")
        buttons = ttk.Frame(self)
        buttons.grid(row=2, column=0, padx=12, pady=12, sticky="e")
        ttk.Button(buttons, text="Use this URL", command=self._ok).pack(side="left")
        ttk.Button(buttons, text="Cancel (stop)", command=self.destroy).pack(side="left", padx=(8, 0))

        self.bind("<Return>", lambda _e: self._ok())
        self.bind("<Escape>", lambda _e: self.destroy())
        entry.focus_set()
        entry.selection_range(0, "end")
        self.grab_set()
        self.wait_window()

    def _ok(self):
        url = self.var.get().strip()
        if not is_valid_url(url):
            messagebox.showwarning("Invalid URL", "The URL must start with http:// or https://", parent=self)
            return
        self.result = url
        self.destroy()


class App:
    def __init__(self, root):
        self.root = root
        self.settings = load_settings()
        self.url_file = self.settings.get("url_file", DEFAULT_URL_FILE)
        try:
            self.relogin_seconds = int(float(self.settings.get("relogin_hours", DEFAULT_RELOGIN_HOURS)) * 3600)
        except (TypeError, ValueError):
            self.relogin_seconds = DEFAULT_RELOGIN_HOURS * 3600

        self.events = queue.Queue()
        self.worker = None
        self.mode = "idle"  # idle | connecting | online | stopping
        self.next_login_at = None

        self._build_ui()
        self._reload_url()
        self._refresh_controls()
        root.report_callback_exception = self._on_tk_error
        root.protocol("WM_DELETE_WINDOW", self._on_close)
        root.after(200, self._poll)
        (self.pass_entry if self.user_var.get() else self.user_entry).focus_set()

    # -- UI ------------------------------------------------------------------------------------

    def _build_ui(self):
        self.root.title("Net KeepAlive")
        self.root.minsize(640, 520)
        frame = ttk.Frame(self.root, padding=12)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(4, weight=1)

        creds = ttk.LabelFrame(frame, text="Internet login", padding=8)
        creds.grid(row=0, column=0, sticky="ew")
        creds.columnconfigure(1, weight=1)
        ttk.Label(creds, text="Username").grid(row=0, column=0, sticky="w")
        self.user_var = tk.StringVar(value=self.settings.get("username", ""))
        self.user_entry = ttk.Entry(creds, textvariable=self.user_var)
        self.user_entry.grid(row=0, column=1, sticky="ew", padx=8, pady=2)
        ttk.Label(creds, text="Password").grid(row=1, column=0, sticky="w")
        self.pass_var = tk.StringVar()
        self.pass_entry = ttk.Entry(creds, textvariable=self.pass_var, show="*")
        self.pass_entry.grid(row=1, column=1, sticky="ew", padx=8, pady=2)
        self.show_var = tk.BooleanVar()
        ttk.Checkbutton(creds, text="Show", variable=self.show_var, command=self._toggle_password).grid(
            row=1, column=2)
        self.pass_entry.bind("<Return>", lambda _e: self._start())

        portal = ttk.LabelFrame(frame, text="Portal URL", padding=8)
        portal.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        portal.columnconfigure(0, weight=1)
        self.url_var = tk.StringVar()
        ttk.Entry(portal, textvariable=self.url_var).grid(row=0, column=0, columnspan=3, sticky="ew")
        self.source_var = tk.StringVar()
        ttk.Label(portal, textvariable=self.source_var, foreground="gray40").grid(
            row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Button(portal, text="Reload from file", command=self._reload_url).grid(
            row=1, column=1, padx=(8, 0), pady=(6, 0))
        ttk.Button(portal, text="Save / apply URL", command=self._apply_url).grid(
            row=1, column=2, padx=(8, 0), pady=(6, 0))

        buttons = ttk.Frame(frame)
        buttons.grid(row=2, column=0, sticky="w", pady=(10, 0))
        self.start_btn = ttk.Button(buttons, text="Start", command=self._start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(buttons, text="Stop", command=self._stop)
        self.stop_btn.pack(side="left", padx=(8, 0))
        self.relogin_btn = ttk.Button(buttons, text="Re-login now", command=self._relogin_now)
        self.relogin_btn.pack(side="left", padx=(8, 0))

        status = ttk.Frame(frame)
        status.grid(row=3, column=0, sticky="ew", pady=(10, 4))
        status.columnconfigure(0, weight=1)
        self.status_var = tk.StringVar(value="Idle")
        ttk.Label(status, textvariable=self.status_var, font=("Segoe UI", 10, "bold")).grid(
            row=0, column=0, sticky="w")
        self.countdown_var = tk.StringVar()
        ttk.Label(status, textvariable=self.countdown_var).grid(row=0, column=1, sticky="e")

        self.log_box = scrolledtext.ScrolledText(frame, height=12, state="disabled", wrap="word")
        self.log_box.grid(row=4, column=0, sticky="nsew")

    def _toggle_password(self):
        self.pass_entry.configure(show="" if self.show_var.get() else "*")

    def _refresh_controls(self):
        idle = self.mode == "idle"
        self.start_btn.state(["!disabled"] if idle else ["disabled"])
        self.stop_btn.state(["disabled"] if idle or self.mode == "stopping" else ["!disabled"])
        self.relogin_btn.state(["!disabled"] if self.mode == "online" else ["disabled"])
        for entry in (self.user_entry, self.pass_entry):
            entry.state(["!disabled"] if idle else ["disabled"])

    def _log(self, text):
        self.log_box.configure(state="normal")
        self.log_box.insert("end", f"[{time.strftime('%H:%M:%S')}] {text}\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def _update_countdown(self):
        if self.mode == "online" and self.next_login_at:
            remaining = max(0, int(self.next_login_at - time.time()))
            self.countdown_var.set(
                f"Next re-login in {remaining // 3600}:{remaining % 3600 // 60:02d}:{remaining % 60:02d}")
        else:
            self.countdown_var.set("")

    # -- URL handling --------------------------------------------------------------------------

    def _reload_url(self):
        url, source = read_url(self.url_file)
        self.url_var.set(url)
        self.source_var.set(f"Loaded from {source}" if source else "No URL file found - using the default URL")

    def _save_url(self, url):
        target = write_url(self.url_file, url)
        if target is None:
            self.source_var.set("Could not save the URL to a file")
            self._log("Could not save the URL to disk.")
        else:
            self.source_var.set(f"Saved to {target}")
            if target != self.url_file:
                self._log(f"{self.url_file} is not available; saved the URL to {target} instead.")

    def _apply_url(self):
        url = self.url_var.get().strip()
        if not is_valid_url(url):
            messagebox.showwarning("Invalid URL", "The URL must start with http:// or https://")
            return
        self._save_url(url)
        if self.mode in ("connecting", "online"):
            self._log("Switching to the new URL...")
            self.worker.switch_url(url)

    # -- actions -------------------------------------------------------------------------------

    def _start(self):
        if self.mode != "idle":
            return
        username = self.user_var.get().strip()
        password = self.pass_var.get()
        url = self.url_var.get().strip()
        if not username or not password:
            messagebox.showwarning("Missing details", "Enter your username and password.")
            return
        if not is_valid_url(url):
            messagebox.showwarning("Invalid URL", "The portal URL must start with http:// or https://")
            return

        self.settings["username"] = username
        try:
            save_settings(self.settings)
        except OSError:
            pass
        self._save_url(url)
        self.worker = KeepAliveWorker(username, password, url, self.relogin_seconds,
                                      lambda kind, **data: self.events.put((kind, data)))
        self.mode = "connecting"
        self._refresh_controls()
        self.worker.start()

    def _stop(self):
        if self.worker and self.mode in ("connecting", "online"):
            self.mode = "stopping"
            self.next_login_at = None
            self.status_var.set("Stopping...")
            self._refresh_controls()
            self.worker.stop()

    def _relogin_now(self):
        if self.worker and self.mode == "online":
            self._log("Re-login requested.")
            self.worker.relogin_now()

    def _on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(
                    "Quit", "Quitting closes the browser and stops keeping your session alive.\nQuit anyway?"):
                return
            self.worker.stop()
            self.worker.join(timeout=10)
            if self.worker.is_alive():
                self.worker.kill_browser()
        self.root.destroy()

    def _on_tk_error(self, exc_type, exc, _tb):
        self._log(f"Internal error: {exc_type.__name__}: {exc}")

    # -- events from the worker ----------------------------------------------------------------

    def _poll(self):
        while True:
            try:
                kind, data = self.events.get_nowait()
            except queue.Empty:
                break
            try:
                getattr(self, f"_on_{kind}")(**data)
            except Exception as exc:
                self._log(f"Internal error handling '{kind}': {exc}")
        self._update_countdown()
        self.root.after(200, self._poll)

    def _on_log(self, text):
        self._log(text)

    def _on_status(self, text):
        if self.mode != "stopping":
            self.status_var.set(text)

    def _on_state(self, value):
        if self.mode == "stopping":
            return
        self.mode = value
        if value != "online":
            self.next_login_at = None
        self._refresh_controls()

    def _on_next_login(self, when):
        self.next_login_at = when

    def _on_url_saved(self, url):
        self.url_var.set(url)
        self._save_url(url)

    def _on_ask_url(self, reason, reply):
        self.root.deiconify()
        self.root.lift()
        self.root.bell()
        dialog = UrlDialog(self.root, reason, self.url_var.get())
        if dialog.result:
            self.url_var.set(dialog.result)
            self._save_url(dialog.result)
        reply.put(dialog.result)

    def _on_error(self, title, text):
        self._log(f"{title}: {text}")
        messagebox.showerror(title, text)

    def _on_stopped(self):
        self.mode = "idle"
        self.next_login_at = None
        self.status_var.set("Stopped")
        self._refresh_controls()
        self._log("Stopped.")


def main():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on high-DPI screens
    except Exception:
        pass
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
