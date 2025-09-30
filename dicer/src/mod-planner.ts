// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { ModuleFramework, Module } from './framework.js';
import { WasmGeom, ManifoldHandle } from './wasm-geom.js';
import { translateGeom } from './cpu-geom.js';
import { PathSegment } from './gcode.js';
import { genPathByProjection, generateStockGeom } from './plan.js';

/**
 * Spark WG1 machine physical configuration.
 */
const sparkWg1Config = {
    toolNaturalDiameter: 3,
    toolNaturalLength: 25,
};

/**
 * Planner class for generating tool paths.
 *
 * This class is not pure function. It's a "module" with UIs and depends on debug stuff.
 * Thus, planner instance should be kept, even when re-running planner from scratch.
 */
export class ModulePlanner implements Module {
    framework: ModuleFramework;
    machineConfig: any;
    stockDiameter: number;
    stockCutWidth: number;
    simWorkBuffer: number;
    showWork: boolean;
    toolLength: number;
    showPlanPath: boolean;
    planPath: PathSegment[];
    baseZ: number;
    aboveWorkSize: number;

    targetManifold: ManifoldHandle;
    stockManifold: ManifoldHandle;

    // View vector for mesh projection
    viewVectorX: number = 0;
    viewVectorY: number = 0;
    viewVectorZ: number = 1;

    wasmGeom: WasmGeom;

    /**
     * @param framework - ModuleFramework instance for visualization management
     */
    constructor(framework: ModuleFramework, wasmGeom: WasmGeom) {
        this.framework = framework;
        this.wasmGeom = wasmGeom;

        this.machineConfig = sparkWg1Config; // in future, there will be multiple options.

        // machine-state setup
        this.stockDiameter = 15;
        this.stockCutWidth = 1.0; // width of tool blade when cutting off the work.
        this.simWorkBuffer = 1.0; // extended bottom side of the work by this amount.

        this.showWork = true;

        this.toolLength = this.machineConfig.toolNaturalLength;
        this.showPlanPath = true;

        this.framework.registerModule(this);
    }

    /**
     * Add planner-specific GUI controls
     * @param gui GUI instance to add controls to
     */
    addGui(gui: GUI) {
        gui.add(this, "showWork")
            .onChange(_ => this.framework.setVisVisibility("work", this.showWork))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.framework.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();

        // wasm-geom testers
        const projectionFolder = gui.addFolder("Mesh Projection");
        projectionFolder.add(this, "viewVectorX", -1, 1, 0.1).name("View X").listen();
        projectionFolder.add(this, "viewVectorY", -1, 1, 0.1).name("View Y").listen();
        projectionFolder.add(this, "viewVectorZ", -1, 1, 0.1).name("View Z").listen();
        projectionFolder.add(this, "randomizeViewVector").name("Randomize");
        projectionFolder.add(this, "projectMesh").name("Project");
    }

    /**
     * Setup new targets.
     *
     * @param baseZ Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
     * @param aboveWorkSize Length of stock to be worked "above" baseZ plane. Note below-baseZ work will be still removed to cut off the work.
     * @param stockDiameter Diameter of the stock.
     */
    initPlan(targetGeom: THREE.BufferGeometry, baseZ: number, aboveWorkSize: number, stockDiameter: number) {
        if (this.targetManifold) {
            this.wasmGeom.destroyManifold(this.targetManifold);
        }
        this.targetManifold = this.wasmGeom.createManifold(targetGeom);
        this.stockDiameter = stockDiameter;
        this.baseZ = baseZ;
        this.aboveWorkSize = aboveWorkSize;
    }

    /**
     * High-level mesh projection with visualization and error handling
     */
    async projectMesh() {
        const simStockLength = this.stockCutWidth + this.simWorkBuffer + this.aboveWorkSize;
        const stockGeom = generateStockGeom(this.stockDiameter / 2, simStockLength);
        translateGeom(stockGeom, new THREE.Vector3(0, 0, -(this.stockCutWidth + this.simWorkBuffer)));
        this.stockManifold = this.wasmGeom.createManifold(stockGeom);

        const res = await genPathByProjection(
            this.targetManifold, this.stockManifold,
            this.wasmGeom, (group, vs, visible) => this.framework.updateVis(group, vs, visible));
        this.planPath = res.path;
        this.stockManifold = res.stockAfterCut;
    }

    /**
     * Randomize view vector
     */
    randomizeViewVector() {
        // Generate random unit vector
        const vec = new THREE.Vector3();
        do {
            vec.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
        } while (vec.lengthSq() < 0.01);

        vec.normalize();
        this.viewVectorX = vec.x;
        this.viewVectorY = vec.y;
        this.viewVectorZ = vec.z;
    }
}
