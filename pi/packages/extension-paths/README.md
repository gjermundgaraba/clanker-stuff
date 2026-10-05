# extension-paths

Resolves consistent config and data paths for Pi extensions.

## Install

```bash
npm install @clanker-stuff/pi-extension-paths
```

## Usage

```ts
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";

const paths = getExtensionStoragePaths("my-extension");
paths.configFile;
paths.dataDir;
```
