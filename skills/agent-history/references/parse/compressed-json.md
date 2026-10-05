# Compressed JSON

Some stores keep JSON payloads compressed inside SQLite BLOBs or files.

## Identify

Look for table columns or metadata that declare compression, or inspect BLOB magic bytes.

## Read a known encoding

Establish the codec from a documented schema, format/version metadata, or a known decoder. Decode relevant thread or message payloads, then inspect their JSON shape and follow the relevant tool card.

If the codec or JSON variant is unknown, report that the payload cannot yet be interpreted. Do not guess a codec from a filename, treat binary strings as a conversation, or claim complete history from surrounding metadata. A readable JSON payload still requires established role, ordering, and content fields for the claims being made.
