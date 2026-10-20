# Wireshark dissector

`uhppote.lua` decodes the UHPPOTE controller protocol (UDP 60000, events on 60001), including the `0xF2`
parameter writes of the UT0311-01A expansion board.

Copy it to `%APPDATA%\Wireshark\plugins\` (Linux/macOS: `~/.local/lib/wireshark/plugins/`), restart Wireshark
and use the display filter `uhppote`. To analyse a capture from the command line: `npm run pcap -- capture.pcapng`.

See [docs/EXPANSION-BOARD.md](../../docs/EXPANSION-BOARD.md#capturing-with-wireshark) for the capture procedure.
