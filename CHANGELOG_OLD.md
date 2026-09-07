# Older changes

## 0.11.0 (2026-09-02)

- New: a UPS added to or removed from the NUT server now appears or disappears at the next poll — no reconnect and no adapter restart needed for a changed server setup
- Fixed: a write to the adapter's own reachable, status or notify states (script, REST API) no longer ends as a SET VAR error in the log; null or object values are rejected before they reach the server
- Fixed: a failed TLS handshake no longer logs a misleading "Connection lost" warning next to the stop, and the notify trigger state echoes the cleaned event text instead of the raw write
- Changed: ioBroker Admin 8.0.11 or newer is required, in line with the current ioBroker stable repository — older Admin installations must be updated before installing this version

## 0.10.0 (2026-09-01)

- New: writable `notify` trigger state — upsmon (or any script) pushes events like ONBATT or SHUTDOWN for an instant refresh, and a matched event also lands on that UPS device (#14)
- Improved: a password accidentally saved with a stray line break is now rejected cleanly instead of silently breaking the connection to the NUT server

## 0.9.0 (2026-08-27)

- New: three states show how many UPS devices were found, how many answer right now, and whether that is all of them — one line to watch instead of every device.
- Fixed: a UPS kept showing as reachable while the adapter was stopped — it now goes offline there, on installations that were updated as well.

## 0.8.0 (2026-08-27)

- New: the adapter now reports crashes to the developer — only if error reporting is enabled in the ioBroker diagnostics settings, and only anonymously without personal data.
- Fixed: a UPS no longer keeps showing as online after the adapter is stopped or while the NUT server cannot be reached — the reachability indicator is now cleared instead of staying green.

## 0.7.0 (2026-08-12)

- Improved: more UPS values now carry their dedicated ioBroker role — mains frequency, status severity and humidity — so charts, visualisations and automatic device detection recognise them correctly.
- Fixed: a driver flag reporting an unusual value is now kept as a text state instead of being misread as a number, so its type no longer changes between updates.

## 0.6.0 (2026-08-11)

- UPS readings now carry their correct data type instead of plain text, so numeric values, yes/no fields and status values can be charted, compared and used directly in scripts.
- Security fix: the NUT username and password no longer appear in the ioBroker log, where they could previously show up in plain text while commands were exchanged.
- A UPS whose name contains a space, dot or other special character now appears correctly in the object tree instead of a broken or missing device entry.

## 0.5.3 (2026-07-26)

- The version history shown in the adapter manager now lists only versions that actually exist for this adapter.

## 0.5.2 (2026-07-26)

- The poll interval can now go down to 2 seconds — below that the NUT driver itself has no new readings to give.

## 0.5.1 (2026-07-13)

- Writable yes/no UPS settings (e.g. automatic restart after power returns) can now actually be changed from ioBroker — previously toggling them was silently rejected by the NUT server.

## 0.5.0 (2026-07-02)

- Device readings now have correct types instead of plain text: yes/no fields become booleans, numeric fields carry their unit, and status, severity and enum fields show a readable label.
- The admin "Test connection" button now reports the real result — a clear error, or the list of discovered UPS devices — instead of always showing "Ok".
- More reliable on slow or flaky networks: no needless drop-and-reconnect, a stalled connection now fails fast instead of hanging, and the adapter recovers instead of getting stuck at startup.
- Clearer status labels: the OFF flag now reads "Off" instead of "Offline", and the on-line flag "On line power" instead of "Online" — so neither is mistaken for a lost network connection.
- When variable writing (SET VAR) is disabled, readings are shown as read-only instead of looking editable but silently ignoring your changes.

## 0.4.5 (2026-06-21)

- With login credentials configured, a NUT server that has more than one UPS no longer leaves the adapter offline (yellow). Multi-UPS setups with authentication now connect and poll correctly.

## 0.4.4 (2026-06-21)

- The network interface setting now offers an "all interfaces" choice and uses it by default, so the adapter binds correctly on multi-homed servers without manual configuration.
- A reading from the NUT server that is not a clean number is no longer stored as a wrong number — non-numeric text stays text, and a numeric field with garbage is skipped and warned once.
- The device name now corrects itself once manufacturer and model become available after the first reading, instead of staying stuck on an earlier placeholder name.
- A UPS variable whose name contains no dot, such as a bare ALARM, is now created as a proper data point instead of an invalid object.

## 0.4.3 (2026-06-18)

- Raised the minimum ioBroker js-controller to 7.2.2, matching the current stable release.
- Internal code and test cleanup — no change to how the adapter behaves.

## 0.4.2 (2026-06-12)

- UPS devices whose NUT server provides no usable description now get a proper name built from manufacturer and model instead of staying at "Description unavailable"
- Number settings with stray characters (like a port of "34abc") no longer half-apply — they fall back to safe defaults
- A UPS that disappears from the NUT server and later returns now reports its first problem at full warning level again

## 0.4.1 (2026-06-10)

- Cleaned up the obsolete `info.online` state left behind by the 0.4.0 rename. It stayed in the object tree frozen at its last value; the adapter now removes it automatically on the next start.

## 0.4.0 (2026-06-10)

- Fixed the connection indicator — it no longer shows green while the connection to the NUT server is actually down.
- Renamed each UPS's `info.online` state to `info.reachable` (does the UPS respond) — distinct from the `status.online` flag (on mains power). Update references in scripts or visualizations.

## 0.3.0 (2026-06-01)

- Added optional TLS encryption via STARTTLS, so your username and password are no longer sent in clear text over the network.
- Charging and discharging are now also detected from the battery charger status, so they work on UPS models that don't report them directly.
- Added status flags for waiting, ECO mode, self-test and overheating, plus clearer labels for more instant commands.
- The adapter now keeps trying to reach the NUT server when it is unavailable and comes back on its own once it returns, instead of staying idle.

## 0.2.9 (2026-05-23)

- Reduced unnecessary state-change events by skipping writes when the value has not changed.
- Fixed duplicate error messages that could appear when running in compact mode.

## 0.2.8 (2026-05-23)

- Changelog rewritten in user-centric style across all versions.

## 0.2.7 (2026-05-23)

- Internal cleanup. No user-facing changes.

## 0.2.6 (2026-05-23)

- Internal cleanup. No user-facing changes.

## 0.2.5 (2026-05-22)

- User-modified state names are no longer overwritten on adapter restart

## 0.2.4 (2026-05-21)

- Improved error handling and stability.

## 0.2.3 (2026-05-19)

- Improved debug logging for easier diagnosis of connection and command issues.

## 0.1.0 (2026-05-18)

- Initial release — complete rewrite of the NUT adapter
- Multi-UPS support: automatic discovery of all UPS devices on a NUT server
- Persistent connection with automatic reconnect
- Dynamic state creation with proper data types and units
- ups.status parsed into individual status flags with severity level
- Instant commands (INSTCMD) and writable variables (SET VAR) with safety checks
- Network interface selector for multi-homed servers
- Connection test button in admin UI
- 11-language admin UI and state names

## 0.2.2 (2026-05-19)

- Replaced PNG icon with SVG for transparent background and dark-mode compatibility

## 0.2.1 (2026-05-19)

- Fixed existing states not being updated on adapter upgrade
- Removed redundant info states. Device name shows manufacturer and model.
- Added translations for 4 additional driver variables (port, synchronous mode, USB library, ignore low battery flag)

## 0.2.0 (2026-05-18)

- Fixed vendor and product IDs: leading zeros are now preserved
- Fixed incorrect unit on extended voltage measurement
- Fixed missing unit "%" for humidity and percent-suffix variables
- Added human-readable status display (e.g. "Online, Charging" instead of "OL CHRG")
- Added HE (High Efficiency / ECO mode) status flag recognition
- Writable variables now show dropdown menus and value ranges in admin
- Added dropdown values for known enum variables (battery charger status, beeper status, outlet switches)
- Device name now shows manufacturer + model when NUT server description is unavailable
- Status flags and variables now display with correct icons and categories in admin and vis
- State names, status flags, and command buttons translated to 11 languages

## 0.1.3 (2026-05-18)

- Fixed connection test now verifies LOGIN per UPS (not just USERNAME/PASSWORD) — catches ACCESS-DENIED before the adapter starts
- Fixed auth failure now fully disconnects from NUT server — no further connection attempts until adapter restart

## 0.1.2 (2026-05-18)

- Fixed authentication failure no longer stops the adapter — stays alive with yellow status so the connection test button remains usable
- Fixed admin UI layout (host, port and poll interval on one row; username and password paired; test button on separate row)

## 0.1.1 (2026-05-18)

- Fixed upgrade from previous adapter version — leftover states are cleaned up automatically
- Fixed state IDs to match previous adapter behavior
- Fixed authentication failure now stops the adapter instead of continuing without permissions
- Fixed connection test now also verifies authentication credentials
- Added per-UPS online indicator (info.online) with device status integration
- Fixed command buttons only created after successful authentication
- Fixed state names now human-readable instead of raw NUT variable names
- Fixed log message order (auth result before "started" message)
- Fixed admin UI layout (network interface and poll interval on separate rows)
