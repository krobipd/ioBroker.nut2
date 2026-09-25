# ioBroker.nut2 — Setting it up

This adapter reads uninterruptible power supplies through a **NUT server** (Network UPS Tools). It never talks to the
UPS directly: the NUT server owns the USB or network connection to the hardware, and the adapter is one of its clients.
That is why every setup starts on the machine the UPS is plugged into.

The README gives the short version. This page walks through a complete setup.

## 1. Make sure a NUT server is running

You need a machine with `upsd` running and at least one UPS configured — a Linux host, a NAS (Synology, QNAP and
UGREEN all ship NUT), or a Raspberry Pi with the UPS on USB.

Check it from that machine:

```bash
upsc -l                 # lists the UPS names, e.g. "ups0"
upsc ups0               # shows all values of that UPS
```

If `upsc -l` prints nothing, the problem is on the NUT side and the adapter cannot help — fix the driver first
(`/etc/nut/ups.conf`, then `upsdrvctl start`).

## 2. Let the adapter reach the server

`upsd` only listens on localhost until you tell it otherwise. In `/etc/nut/upsd.conf`:

```
LISTEN 0.0.0.0 3493
```

Restart `upsd` afterwards. Port `3493/TCP` has to be open between your ioBroker host and the NUT server.

Many NAS systems run NUT in a "UPS server" mode that has its own allow-list in the web interface — the ioBroker host's
IP address has to be in it.

## 3. Create a user (optional, but recommended)

Reading values needs no login at all. You only need a user for two things: switching the UPS (instant commands) and
writing variables. Add it to `/etc/nut/upsd.users`:

```
[iobroker]
    password = choose-something-long
    upsmon secondary
    actions = SET
    instcmds = ALL
```

Two lines with different jobs:

- `upsmon secondary` is what makes a **login** possible. The adapter uses a login once at startup, on a short extra
  connection, purely to tell you whether the credentials work. Without this line the login is refused — see the FAQ,
  it is not an error.
- `actions` and `instcmds` decide what the user may actually **do**. `upsd` checks them per command, independently of
  the login.

Restart `upsd` after editing the file.

## 4. Add the instance in ioBroker

Install the adapter, create an instance, and fill in the **Connection** tab:

| Setting             | What to put in                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| NUT server host     | Hostname or IP of the machine running `upsd`                                                      |
| Port                | `3493` unless you changed it                                                                      |
| Network interface   | Leave on "all" unless your ioBroker host has several networks and only one reaches the NUT server |
| Poll interval       | `15` seconds is a good default — see below                                                        |
| Username / Password | The user from step 3, or leave empty for read-only monitoring                                     |

Press **Test connection**. The answer names what was actually checked: whether the connection is encrypted, how many
UPS devices the server offers, and — if you entered credentials — whether the login was accepted.

Then save. The adapter connects, discovers every UPS on the server and creates the states.

### How fast should it poll?

Faster than the NUT driver refreshes its data buys you nothing. In `/etc/nut/ups.conf` the driver has two settings:
`pollinterval` (how often the status is refreshed, default 2 s) and `pollfreq` (the full set of values, default 30 s
for USB drivers). Polling every 15 seconds is a sensible middle ground; below 2 seconds the adapter simply re-reads
values that have not changed.

If you want to know about a power failure _the instant it happens_ rather than at the next poll, do not lower the
interval — use the event trigger described in the FAQ.

## 5. Encrypting the connection (optional)

Without TLS the username and password travel the network in clear text. If that matters in your setup, `upsd` can be
built with TLS support and offers **STARTTLS**:

1. Configure `CERTFILE` (or `CERTPATH`) in `upsd.conf` on the server.
2. Tick **Use TLS (STARTTLS)** in the adapter.

By default the adapter does not verify the certificate — that encrypts the traffic against passive eavesdropping, but
it cannot detect a man-in-the-middle, because almost every NUT server uses a self-signed certificate.

For real protection, tick **Require valid certificate** as well and point **CA certificate file** at a PEM file on the
ioBroker host that the certificate can be checked against — your own certificate authority, or the server's
self-signed certificate itself. The file is only read while the strict check is on; a path left behind from an earlier
attempt does no harm.

If the NUT server was built without TLS, the connection test says so instead of quietly falling back to plain text.

## 6. Switching the UPS from ioBroker (optional)

Two switches on the **Advanced** tab open the write direction, and both are off on purpose:

- **Enable commands** creates a button state per instant command the UPS offers (beeper, self-test, load off …).
  The `commands` channel only appears once this is on **and** credentials are configured — `upsd` checks command
  rights against a named user. Its text data point `commands.execute` runs a command that takes a value, such as
  `load.off.delay 120`.
- **Enable SET VAR** makes the UPS variables that the server reports as writable writable in ioBroker too.

Both need the matching rights in `upsd.users` (step 3). Handle the load commands with care: `load.off` cuts the power
to everything plugged into the UPS.

## Where to go next

- [Data points](datapoints.md) — what the adapter creates and what each part means.
- [Frequently asked questions](faq.md) — including instant event updates via `upsmon`.
