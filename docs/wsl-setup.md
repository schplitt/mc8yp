# WSL 2 keyring setup

Native Windows is not supported: the sandbox runtime talks to its Rust subprocess over Unix domain sockets. Use WSL 2 or the microservice. On WSL 2, `mc8yp creds add` needs a one-time keyring setup first.

A fresh WSL 2 distro has no Secret Service provider, no session D-Bus, and no `login` keyring collection, so `@napi-rs/keyring` (used by `mc8yp creds add`) has nothing to talk to. On a normal desktop Linux all of this is wired up automatically by the display manager and PAM; on WSL you have to do it once manually.

**1. Inside WSL, install the keyring stack:**

```sh
sudo apt install -y libsecret-tools dbus-x11
sudo apt install -y libpam-gnome-keyring
```

- `libsecret-tools` provides `secret-tool` and pulls in `libsecret` (the client library `@napi-rs/keyring` uses).
- `dbus-x11` provides `dbus-launch` so a session D-Bus can be started in a headless shell.
- `libpam-gnome-keyring` installs `gnome-keyring-daemon` (the actual Secret Service provider) and its PAM module.

**2. Force the keyring database to initialize:**

```sh
secret-tool store --label="init" init init
```

A throwaway write so `gnome-keyring-daemon` creates its on-disk store.

**3. Wire up PAM so the keyring auto-unlocks at login:**

```sh
sudo bash -c 'cat >> /etc/pam.d/login <<EOF
auth optional pam_gnome_keyring.so
session optional pam_gnome_keyring.so auto_start
EOF'
```

**4. From PowerShell, fully restart WSL so PAM picks up the new config:**

```powershell
wsl --shutdown
```

**5. Back in WSL, start a session D-Bus (WSL doesn't get one by default):**

```sh
echo $DBUS_SESSION_BUS_ADDRESS   # should be empty
eval $(dbus-launch --sh-syntax)
```

**6. Create the `login` collection that libsecret writes into.** On a normal desktop this is created by the graphical login session; on WSL it does not exist and credential writes will fail without it:

```sh
gdbus call --session \
  --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets \
  --method org.freedesktop.Secret.Service.OpenSession \
  "plain" \
  "<''>"

gdbus call --session \
  --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets \
  --method org.freedesktop.Secret.Service.CreateCollection \
  "{'org.freedesktop.Secret.Collection.Label': <'login'>}" \
  ""
```

**7. Trigger the keyring passphrase prompt once:**

```sh
secret-tool store --label="test" service myservice username myuser
```

This opens a prompt to set the keyring passphrase. You can leave it **empty** — the keyring will then auto-unlock without prompting later, which is what you want for headless WSL.

After this, `mc8yp creds add` will work.
