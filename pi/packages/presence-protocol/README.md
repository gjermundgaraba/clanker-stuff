# presence-protocol

The pi.events contract extensions use to tell presence what work a session has parked with them.

## Install

This private workspace library is consumed through `workspace:^`.

## Usage

Emit `{source, items: [{id, about}]}` on `PARKED_CHANNEL` whenever a source's parked work changes; each report replaces that source's previous one.
