// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { ModuleFramework, Module } from './framework.js';
import { ModulePlanner } from './mod-planner.js';
import { computeAABB } from './tracking-voxel.js';
import { visDot } from './debug.js';
import { initWasmGeom, WasmGeom, toTriSoup } from './wasm-geom.js';


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
    targetSurf: Float64Array;

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

    // View vector for mesh projection
    viewVectorX: number = 0;
    viewVectorY: number = 0;
    viewVectorZ: number = 1;

    // Subtract sphere radius
    subtractRadius: number = 5;

    wasmGeom: WasmGeom | null;

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
            COLLET: "collet",
            IDLER: "idler",
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

        initWasmGeom().then(wg => {
            this.wasmGeom = wg;
            console.log("WASM Geom module initialized");
        });
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

        // Subtract button and radius slider
        gui.add(this, "subtractRadius", 1, 15, 0.1).name("Subtract Radius").listen();
        gui.add(this, "subtractMeshWASM").name("Subtract (Manifold)");
        gui.add(this, "testCubeMinusSphere").name("Test: Cube - Sphere (Manifold)");

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

                this.targetSurf = toTriSoup(geometry);
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
     * Generate sphere geometry
     * @param radius Sphere radius
     * @returns Sphere geometry
     */
    private generateSphereGeometry(radius: number): THREE.BufferGeometry {
        const geom = new THREE.SphereGeometry(radius, 32, 16);
        geom.translate(1, 0, 0);
        return geom;
    }

    /**
     * Generate cube geometry
     * @param size Cube size (width, height, depth)
     * @returns Cube geometry
     */
    private generateCubeGeometry(size: number = 10): THREE.BufferGeometry {
        const geom = new THREE.BoxGeometry(size, size, size);
        return geom;
    }

    /**
     * Simple test: Cube minus Sphere
     */
    async testCubeMinusSphere() {
        try {
            console.log(`Testing: Cube (size=10) - Sphere (radius=${this.subtractRadius})`);

            // Generate cube and sphere meshes
            const cubeGeometry = this.generateCubeGeometry(10);
            const sphereGeometry = this.generateSphereGeometry(this.subtractRadius);

            // Perform subtraction (cube - sphere) using C++ Manifold
            const startTime = performance.now();
            const geometry = this.wasmGeom.subtractMesh(cubeGeometry, sphereGeometry);
            const endTime = performance.now();

            const numTris = geometry.getAttribute('position').count / 3;
            console.log(`Test subtraction (C++ Manifold) completed in ${(endTime - startTime).toFixed(2)}ms. Result has ${numTris} triangles`);

            // Create mesh with a different color for test result
            const material = new THREE.MeshPhysicalMaterial({
                color: 0x80ff80,  // Light green color for test result
                metalness: 0.1,
                roughness: 0.8,
                transparent: true,
                wireframe: true
            });

            const mesh = new THREE.Mesh(geometry, material);
            this.framework.updateVis("misc", [mesh]);

            this.framework.updateVis("misc", [mesh]);

        } catch (error) {
            console.error("Test cube-sphere subtraction failed:", error);
        }
    }

    /**
     * Subtract sphere from target surface and display result
     */
    async subtractMeshWASM() {
        try {
            console.log(`Subtracting sphere (radius=${this.subtractRadius}) from target surface...`);

            // Generate sphere mesh
            const sphereGeometry = this.generateSphereGeometry(this.subtractRadius);

            // Create geometry from targetSurf
            const targetGeometry = new THREE.BufferGeometry();
            const targetPositions = new Float32Array(this.targetSurf.length);
            for (let i = 0; i < this.targetSurf.length; i++) {
                targetPositions[i] = this.targetSurf[i];
            }
            targetGeometry.setAttribute('position', new THREE.BufferAttribute(targetPositions, 3));

            // Perform subtraction using C++ Manifold via WASM
            const startTime = performance.now();
            const geometry = this.wasmGeom.subtractMesh(targetGeometry, sphereGeometry);
            const endTime = performance.now();

            const numTris = geometry.getAttribute('position').count / 3;
            console.log(`C++ Manifold subtraction completed in ${(endTime - startTime).toFixed(2)}ms. Result has ${numTris} triangles`);

            // Create mesh with a different color
            const material = new THREE.MeshPhysicalMaterial({
                color: 0xff8080,  // Light red color for subtracted result
                metalness: 0.1,
                roughness: 0.8,
                transparent: true,
                wireframe: true,
                opacity: 0.9,
            });

            const mesh = new THREE.Mesh(geometry, material);
            this.framework.updateVis("misc", [mesh]);

        } catch (error) {
            console.error("Mesh subtraction failed:", error);
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
            // Create geometry from targetSurf
            const targetGeometry = new THREE.BufferGeometry();
            const targetPositions = new Float32Array(this.targetSurf.length);
            for (let i = 0; i < this.targetSurf.length; i++) {
                targetPositions[i] = this.targetSurf[i];
            }
            targetGeometry.setAttribute('position', new THREE.BufferAttribute(targetPositions, 3));

            const contours = this.wasmGeom.projectMesh(targetGeometry, origin, viewX, viewY, viewZ);
            const endTime = performance.now();
            console.log(`WASM projection: ${this.targetSurf.length / 9} tris, ${(endTime - startTime).toFixed(2)}ms. ${contours.length} contour(s)`);

            // Visualize contours on the view plane using LineLoop
            const contourObjects: THREE.Object3D[] = [];
            for (const contour of contours) {
                // Transform 2D contour points back to 3D using orthonormal basis
                const points3D: THREE.Vector3[] = [];
                for (const point2D of contour) {
                    const point3D = origin.clone()
                        .add(viewX.clone().multiplyScalar(point2D.x))
                        .add(viewY.clone().multiplyScalar(point2D.y));
                    points3D.push(point3D);
                }

                const geometry = new THREE.BufferGeometry().setFromPoints(points3D);
                const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
                const lineLoop = new THREE.LineLoop(geometry, material);
                contourObjects.push(lineLoop);
            }

            this.framework.updateVis("misc", contourObjects);
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
