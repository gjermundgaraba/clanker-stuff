# extension-paths

Resolves consistent config, data, cache, and project config paths for Pi extensions.

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
paths.project(cwd).configFile;
```
