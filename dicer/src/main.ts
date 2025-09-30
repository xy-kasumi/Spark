// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Entrypoint for the dicer app.
 */
import { ModuleFramework } from './framework.js';
import { ModulePlanner } from './mod-planner.js';
import { ModuleLayout } from './mod-layout.js';
import { initWasmGeom } from './wasm-geom.js';

(async () => {
    console.log("window.crossOriginIsolated", window.crossOriginIsolated);
    
    const framework = new ModuleFramework();

    const wasmGeom = await initWasmGeom();
    const modulePlanner = new ModulePlanner(framework, wasmGeom);
    const moduleLayout = new ModuleLayout(framework, modulePlanner);
})();
