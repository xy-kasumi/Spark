// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { ModuleFramework, Module } from './framework.js';
import { ModulePlanner } from './mod-planner.js';
import { computeAABB } from './tracking-voxel.js';
import { visDot } from './debug.js';

/**
 * Get "triangle soup" representation from a geometry
 * @param geom Input geometry
 * @returns Triangle soup array
 */
const convGeomToSurf = (geom: THREE.BufferGeometry): Float32Array => {
    if (geom.index === null) {
        console.log("convGeomToSurf: converting from non-indexed geometry");
        return geom.getAttribute("position").array;
    } else {
        console.log("convGeomToSurf: converting from indexed geometry");
        const ix = geom.index.array;
        const pos = geom.getAttribute("position").array;

        const numTris = ix.length / 3;
        const buf = new Float32Array(numTris * 9);
        for (let i = 0; i < numTris; i++) {
            for (let v = 0; v < 3; v++) {
                const vIx = ix[3 * i + v];
                buf[9 * i + 3 * v + 0] = pos[3 * vIx + 0];
                buf[9 * i + 3 * v + 1] = pos[3 * vIx + 1];
                buf[9 * i + 3 * v + 2] = pos[3 * vIx + 2];
            }
        }
        return buf;
    }
};

/**
 * Generate stock cylinder geometry, spanning Z [0, stockHeight]
 * @param stockRadius Radius of the stock
 * @param stockHeight Height of the stock
 * @returns Stock cylinder geometry
 */
const generateStockGeom = (stockRadius: number = 7.5, stockHeight: number = 15): THREE.BufferGeometry => {
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};

const generateStockVis = (stockRadius: number = 7.5, stockHeight: number = 15, baseZ: number = 0): THREE.Object3D => {
    const geom = generateStockGeom(stockRadius, stockHeight);
    const mat = new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.z = -baseZ;
    return mesh;
};

/**
 * Module that controls model loading, laying out the model & work, and sending out G-code.
 */
export class ModuleLayout implements Module {
    framework: ModuleFramework;
    
    // Model data
    models: Record<string, string>;
    model: string;
    targetSurf: Float32Array;
    
    // Stock configuration
    stockDiameter: number;
    stockLength: number;
    stockTopBuffer: number;
    baseZ: number;
    aboveWorkSize: number;
    showStockMesh: boolean;
    showTargetMesh: boolean;

    // target configuration
    initToolLen: number;  // must be larger than actual current tool len to avoid collision
    targToolLen: number; // target tool length after cutting
    wireFeedRate: number;
    pulseCondition: string; // e.g. "M4 P150 Q20 R40"
    
    // Planning module
    modPlanner: ModulePlanner;
    
    // WASM module instance
    wasmModule: any = null;
    
    // View vector for mesh projection
    viewVectorX: number = 0;
    viewVectorY: number = 0;
    viewVectorZ: number = 1;

    constructor(framework: ModuleFramework, modPlanner: ModulePlanner) {
        this.framework = framework;
        this.modPlanner = modPlanner;

        // Setup data
        this.models = {
            GT2_PULLEY: "GT2_pulley",
            HELICAL_GEAR: "helical_gear",
            HELICAL_GEAR_STANDING: "helical_gear_standing",
            LATTICE: "cube_lattice",
            BENCHY: "benchy_25p",
            BOLT_M3: "M3x10",
            FRACTAL_STEP: "fractal_step",
        };

        this.model = this.models.GT2_PULLEY;
        this.stockDiameter = 15;
        this.stockLength = 20;
        this.stockTopBuffer = 0.5;
        this.showStockMesh = true;
        this.showTargetMesh = true;
        this.framework.updateVis("stock", [generateStockVis(this.stockDiameter / 2, this.stockLength, this.baseZ)], this.showStockMesh);

        this.initToolLen = 35;
        this.targToolLen = 10;
        this.wireFeedRate = 200;
        this.pulseCondition = "M4 P150 Q20 R40";

        this.framework.registerModule(this);
    }

    #updateStockVis() {
        this.framework.updateVis("stock", [generateStockVis(this.stockDiameter / 2, this.stockLength, this.baseZ)], this.showStockMesh);
    }

    /**
     * Add main module GUI controls
     * @param gui GUI instance to add controls to
     */
    addGui(gui: GUI) {
        gui.add(this, 'model', this.models).onChange((model) => {
            this.framework.updateVis("targ-vg", []);
            this.framework.updateVis("work-vg", []);
            this.framework.updateVis("misc", []);
            this.loadStl(model);
        });
        gui.add(this, "stockDiameter", 1, 30, 0.1).onChange(_ => {
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "stockLength", 1, 30, 0.1).onChange(_ => {
            this.baseZ = this.stockLength - this.aboveWorkSize;
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.framework.setVisVisibility("stock", v);
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.framework.setVisVisibility("target", v);
        }).listen();

        // tool cut
        gui.add(this, "initToolLen", 9, 35, 0.1);
        gui.add(this, "targToolLen", 9, 35, 0.1);
        gui.add(this, "wireFeedRate", 10, 1000, 10);
        gui.add(this, "pulseCondition");

        gui.add(this, "copyGcode");
        gui.add(this, "sendGcodeToSim");
        
        // View vector controls
        const projectionFolder = gui.addFolder("Mesh Projection");
        projectionFolder.add(this, "viewVectorX", -1, 1, 0.1).name("View X").listen();
        projectionFolder.add(this, "viewVectorY", -1, 1, 0.1).name("View Y").listen();
        projectionFolder.add(this, "viewVectorZ", -1, 1, 0.1).name("View Z").listen();
        projectionFolder.add(this, "randomizeViewVector").name("Randomize");
        projectionFolder.add(this, "projectMeshWASM").name("Project");

        this.loadStl(this.model);
    }

    /**
     * Load STL model
     * @param fname Model filename
     */
    loadStl(fname: string) {
        const loader = new STLLoader();
        loader.load(
            `../assets/models/${fname}.stl`,
            (geometry) => {
                // hack to align geometry
                // TODO: Remove this when we have part orientation setup in GUI.
                if (fname === this.models.FRACTAL_STEP) {
                    geometry.translate(-1, 0, 2);
                }

                this.targetSurf = convGeomToSurf(geometry);
                const aabb = computeAABB(this.targetSurf);
                // assuming aabb.min.z == 0.
                this.aboveWorkSize = aabb.max.z + this.stockTopBuffer;
                this.baseZ = this.stockLength - this.aboveWorkSize;
                this.#updateStockVis();
                this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);

                const material = new THREE.MeshPhysicalMaterial({
                    color: 0xb2ffc8,
                    metalness: 0.1,
                    roughness: 0.8,
                    transparent: true,
                    opacity: 0.8,
                });
                this.framework.updateVis("target", [new THREE.Mesh(geometry, material)]);
            },
            (progress) => {
                console.log('Loading progress: ', progress);
            },
            (error) => {
                console.error('Loading error: ', error);
            }
        );
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

    /**
     * Pure WASM wrapper - calls C++ projection function and returns TypeScript objects
     * @param triangleSoup - Float32Array of vertex data (x,y,z per vertex, 3 vertices per triangle)
     * @param origin - 3D origin point for projection plane
     * @param viewX - X axis of projection coordinate system (must be orthonormal)
     * @param viewY - Y axis of projection coordinate system (must be orthonormal) 
     * @param viewZ - Z axis of projection coordinate system (viewing direction, must be orthonormal)
     * @returns Array of 2D edges or throws error string
     */
    private async callWasmProjectMesh(
        triangleSoup: Float32Array, 
        origin: THREE.Vector3,
        viewX: THREE.Vector3,
        viewY: THREE.Vector3,
        viewZ: THREE.Vector3
    ): Promise<{start: THREE.Vector2, end: THREE.Vector2}[]> {
        // Load WASM module if not already loaded
        if (!this.wasmModule) {
            // @ts-ignore - WASM module will be generated at build time
            const MeshProjectModule = (await import('./wasm/mesh_project.js')).default;
            this.wasmModule = await MeshProjectModule();
        }
        
        const Module = this.wasmModule;
        const numVertices = triangleSoup.length / 3;
        
        // Allocate and populate triangle_soup struct
        const soupPtr = Module._malloc(8);
        const verticesPtr = Module._malloc(numVertices * 12);
        Module.HEAPF32.set(triangleSoup, verticesPtr / 4);
        Module.setValue(soupPtr, numVertices, 'i32');
        Module.setValue(soupPtr + 4, verticesPtr, 'i32');
        
        // Allocate and populate view parameters
        const originPtr = Module._malloc(12);
        const viewXPtr = Module._malloc(12);
        const viewYPtr = Module._malloc(12);
        const viewZPtr = Module._malloc(12);
        Module.HEAPF32.set([origin.x, origin.y, origin.z], originPtr / 4);
        Module.HEAPF32.set([viewX.x, viewX.y, viewX.z], viewXPtr / 4);
        Module.HEAPF32.set([viewY.x, viewY.y, viewY.z], viewYPtr / 4);
        Module.HEAPF32.set([viewZ.x, viewZ.y, viewZ.z], viewZPtr / 4);
        
        try {
            // Call WASM function
            const resultPtr = Module._project_mesh(soupPtr, originPtr, viewXPtr, viewYPtr, viewZPtr);
            if (!resultPtr) throw new Error("project_mesh returned null");
            
            // Read result
            const numEdges = Module.getValue(resultPtr, 'i32');
            const edgesPtr = Module.getValue(resultPtr + 4, 'i32');
            const errorMsgPtr = Module.getValue(resultPtr + 8, 'i32');
            
            // Check for error
            if (errorMsgPtr !== 0) {
                const errorMsg = Module.UTF8ToString(errorMsgPtr);
                throw new Error(errorMsg);
            }
            
            // Convert edges to TypeScript objects
            const edges: {start: THREE.Vector2, end: THREE.Vector2}[] = [];
            for (let i = 0; i < numEdges; i++) {
                const edgePtr = edgesPtr + i * 16;
                const startX = Module.HEAPF32[edgePtr / 4 + 0];
                const startY = Module.HEAPF32[edgePtr / 4 + 1];
                const endX = Module.HEAPF32[edgePtr / 4 + 2];
                const endY = Module.HEAPF32[edgePtr / 4 + 3];
                edges.push({
                    start: new THREE.Vector2(startX, startY),
                    end: new THREE.Vector2(endX, endY)
                });
            }
            
            // Clean up result
            Module._free_edge_soup(resultPtr);
            return edges;
            
        } finally {
            // Always clean up input memory
            Module._free(soupPtr);
            Module._free(verticesPtr);
            Module._free(originPtr);
            Module._free(viewXPtr);
            Module._free(viewYPtr);
            Module._free(viewZPtr);
        }
    }

    /**
     * High-level mesh projection with visualization and error handling
     */
    async projectMeshWASM() {
        try {
            // Create and validate view vector
            const viewVector = new THREE.Vector3(this.viewVectorX, this.viewVectorY, this.viewVectorZ);
            if (viewVector.length() < 0.001) {
                throw new Error("View vector too small");
            }
            
            // Generate orthonormal basis from view vector
            const viewZ = viewVector.clone().normalize();
            const temp = Math.abs(viewZ.dot(new THREE.Vector3(1, 0, 0))) > 0.9 ? 
                         new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            const viewX = temp.clone().sub(viewZ.clone().multiplyScalar(temp.dot(viewZ))).normalize();
            const viewY = viewZ.clone().cross(viewX);
            const origin = new THREE.Vector3(0, 0, 0);
            
            console.log(`View basis: X(${viewX.x.toFixed(3)}, ${viewX.y.toFixed(3)}, ${viewX.z.toFixed(3)}) ` +
                       `Y(${viewY.x.toFixed(3)}, ${viewY.y.toFixed(3)}, ${viewY.z.toFixed(3)}) ` +
                       `Z(${viewZ.x.toFixed(3)}, ${viewZ.y.toFixed(3)}, ${viewZ.z.toFixed(3)})`);
            
            // Call pure WASM wrapper
            const startTime = performance.now();
            const edges = await this.callWasmProjectMesh(this.targetSurf, origin, viewX, viewY, viewZ);
            const endTime = performance.now();
            console.log(`WASM projection: ${this.targetSurf.length / 9} tris, ${(endTime - startTime).toFixed(2)}ms. ${edges.length} silhouette edge(s)`);
            
            // Visualize edges on the view plane
            const edgeObjects: THREE.Object3D[] = [];
            for (const edge of edges) {
                // Transform 2D edge coordinates back to 3D using orthonormal basis
                const start3D = origin.clone()
                    .add(viewX.clone().multiplyScalar(edge.start.x))
                    .add(viewY.clone().multiplyScalar(edge.start.y));
                const end3D = origin.clone()
                    .add(viewX.clone().multiplyScalar(edge.end.x))
                    .add(viewY.clone().multiplyScalar(edge.end.y));
                    
                const points = [start3D, end3D];
                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
                const line = new THREE.LineSegments(geometry, material);
                edgeObjects.push(line);
            }
            
            this.framework.updateVis("misc", edgeObjects);
        } catch (error) {
            console.error("WASM projection failed:", error);
            
            // Handle coordinate pattern errors with visualization
            const errorMsg = error instanceof Error ? error.message : String(error);
            const coordPattern = /\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)-\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)/;
            const match = errorMsg.match(coordPattern);
            
            if (match) {
                const p1 = new THREE.Vector3(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
                const p2 = new THREE.Vector3(parseFloat(match[4]), parseFloat(match[5]), parseFloat(match[6]));
                
                const errorObjects: THREE.Object3D[] = [visDot(p1, "red"), visDot(p2, "red")];
                this.framework.updateVis("misc", errorObjects);
            }
        }
    }

    copyGcode() {
        const gcode = this.generateGcode();
        navigator.clipboard.writeText(gcode);
        console.log("G-code copied to clipboard");
    }

    sendGcodeToSim() {
        const gcode = this.generateGcode();
        const bc = new BroadcastChannel("gcode");
        bc.postMessage(gcode);
        bc.close();
        console.log("G-code sent to sim");
    }

    generateGcode(): string {
        const planPath = this.modPlanner.planPath || [];

        let prevSweep = null;
        let prevType = null;
        let prevX = null;
        let prevY = null;
        let prevZ = null;
        let prevB = null;
        let prevC = null;

        const lines = [];

        const grinderZEvacBuffer = 15; // buffer for Z evacuation after grinding

        lines.push(`; init`);
        lines.push(`G28`);  // home

        lines.push(`G54`); // use grinder coordinate system
        lines.push(`G0 Y0 Z${grinderZEvacBuffer + this.initToolLen} X-5`); // safe position
        lines.push(`G0 Z${this.targToolLen}`); // insert tool into grinder

        lines.push(`M10 R${this.wireFeedRate}`);
        lines.push(this.pulseCondition);
        lines.push(`G1 X5`); // cut tool end

        lines.push(`G0 Z${grinderZEvacBuffer + this.targToolLen}`); // evaculate
        lines.push(`M11`); // end wire feed

        lines.push(`G53`); // revert to machine coord for next commands


        lines.push("");
        return lines.join("\n");

        // normal code
        for (let i = 0; i < planPath.length; i++) {
            const pt = planPath[i];
            if (prevSweep !== pt.sweep) {
                lines.push(`; sweep-${pt.sweep}`);
                prevSweep = pt.sweep;
            }

            let gcode = [];
            if (pt.type === "remove-work") {
                if (prevType !== pt.type) {
                    lines.push(`M3 WV100`);
                }
                gcode.push("G1");
            } else if (pt.type === "remove-tool") {
                if (prevType !== pt.type) {
                    lines.push(`M4 GV-100`);
                }
                gcode.push("G1");
            } else if (pt.type === "move-out" || pt.type === "move-in" || pt.type === "move") {
                if (prevType !== pt.type) {
                    lines.push(`M5`);
                }
                gcode.push("G0");
            } else {
                console.error("unknown path segment type", pt.type);
            }
            prevType = pt.type;

            const vals = pt.axisValues;
            if (prevX !== vals.x) {
                gcode.push(`X${vals.x.toFixed(3)}`);
                prevX = vals.x;
            }
            if (prevY !== vals.y) {
                gcode.push(`Y${vals.y.toFixed(3)}`);
                prevY = vals.y;
            }
            if (prevZ !== vals.z) {
                gcode.push(`Z${vals.z.toFixed(3)}`);
                prevZ = vals.z;
            }
            if (prevB !== vals.b) {
                gcode.push(`B${(vals.b * 180 / Math.PI).toFixed(3)}`);
                prevB = vals.b;
            }
            if (prevC !== vals.c) {
                gcode.push(`C${(vals.c * 180 / Math.PI).toFixed(3)}`);
                prevC = vals.c;
            }
            if (pt.toolRotDelta !== undefined) {
                gcode.push(`D${(pt.toolRotDelta * 180 / Math.PI).toFixed(2)}`);
            }
            if (pt.grindDelta !== undefined) {
                gcode.push(`GW${pt.grindDelta.toFixed(1)}`);
            }

            lines.push(gcode.join(" "));
        }

        lines.push(`; end`);
        lines.push(`M103`);

        lines.push("");
        return lines.join("\n");
    }
}
