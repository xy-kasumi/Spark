// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Entrypoint for the dicer app.
 */
import { loadFont } from './debug.js';
import { ModuleFramework } from './framework.js';
import { ModulePlanner } from './mod-planner.js';
import { ModuleLayout } from './mod-layout.js';

(async () => {
    console.log("window.crossOriginIsolated", window.crossOriginIsolated);
    
    await loadFont();
    const framework = new ModuleFramework();
    
    const modulePlanner = new ModulePlanner(framework);
    const moduleLayout = new ModuleLayout(framework, modulePlanner);
})();
