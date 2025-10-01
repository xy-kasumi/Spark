// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { ModuleFramework, Module } from './framework.js';
import { WasmGeom, ManifoldHandle } from './wasm-geom.js';
import { translateGeom, computeAABB } from './cpu-geom.js';
import { PathSegment, generateGcode } from './gcode.js';
import { genPathByProjection, generateStockGeom } from './plan.js';

const stdWorkPulseCondition = "M3 P150 Q20 R50";

const generateStockVis = (stockRadius: number = 7.5, stockHeight: number = 15, baseZ: number = 0): THREE.Object3D => {
    const geom = generateStockGeom(stockRadius, stockHeight);
    const mat = new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.z = -baseZ;
    return mesh;
};

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
    stockCutWidth: number;
    simWorkBuffer: number;
    showWork: boolean;
    toolLength: number;
    showPlanPath: boolean;
    planPath: PathSegment[];

    targetManifold: ManifoldHandle;
    stockManifold: ManifoldHandle;

    // View vector for mesh projection
    viewVectorX: number = 0;
    viewVectorY: number = 0;
    viewVectorZ: number = 1;

    wasmGeom: WasmGeom;


    // Model data
    models: Record<string, string>;
    model: string;
    origTargGeom: THREE.BufferGeometry;
    targetGeom: THREE.BufferGeometry;

    // Stock configuration
    stockDiameter: number;
    stockLength: number;
    stockTopBuffer: number;
    baseZ: number;
    aboveWorkSize: number;
    showStockMesh: boolean;
    showTargetMesh: boolean;

    // target configuration
    pulseCondition: string; // e.g. "M4 P150 Q20 R40"

    /**
     * @param framework - ModuleFramework instance for visualization management
     */
    constructor(framework: ModuleFramework, wasmGeom: WasmGeom) {
        this.framework = framework;
        this.wasmGeom = wasmGeom;


        // Setup data
        this.models = {
            GT2_PULLEY: "GT2_pulley",
            HELICAL_GEAR: "helical_gear",
            LATTICE: "cube_lattice",
            BENCHY: "benchy_25p",
            BOLT_M3: "M3x10",
            COLLET: "collet",
            IDLER: "idler",
            FRACTAL_STEP: "fractal_step",
            BEARING_INNER: "bearing_inner",
            BEARING_OUTER: "bearing_outer",
            SPRING_CONTACT: "spring_contact",
            WAVE_R2: "wave_r2",
        };

        this.model = this.models.GT2_PULLEY;
        this.stockDiameter = 15;
        this.stockLength = 20;
        this.stockTopBuffer = 0.5;
        this.showStockMesh = true;
        this.showTargetMesh = true;
        this.framework.updateVis("stock", [generateStockVis(this.stockDiameter / 2, this.stockLength, this.baseZ)], this.showStockMesh);

        this.pulseCondition = "M4 P150 Q20 R40";

        this.machineConfig = sparkWg1Config; // in future, there will be multiple options.

        // machine-state setup
        this.stockDiameter = 15;
        this.stockCutWidth = 1.0; // width of tool blade when cutting off the work.
        this.simWorkBuffer = 1.0; // extended bottom side of the work by this amount.

        this.showWork = true;

        this.toolLength = this.machineConfig.toolNaturalLength;
        this.showPlanPath = true;

        this.loadSettings();
        this.framework.registerModule(this);
    }


    #updateStockVis() {
        this.framework.updateVis("stock", [generateStockVis(this.stockDiameter / 2, this.stockLength, this.baseZ)], this.showStockMesh);
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

        gui.add(this, 'model', this.models).onChange((model) => {
            this.framework.updateVis("targ-vg", []);
            this.framework.updateVis("work-vg", []);
            this.framework.updateVis("misc", []);
            this.loadStl(model);
        });
        gui.add(this, "rotX90").name("Rotate 90° around X");
        gui.add(this, "rotY90").name("Rotate 90° around Y");

        gui.add(this, "stockDiameter", 1, 30, 0.1).onChange(_ => {
            this.storeSettings();
            this.#updateStockVis();
            this.initPlan(this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "stockLength", 1, 30, 0.1).onChange(_ => {
            this.baseZ = this.stockLength - this.aboveWorkSize;
            this.#updateStockVis();
            this.initPlan(this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.framework.setVisVisibility("stock", v);
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.framework.setVisVisibility("target", v);
        }).listen();

        gui.add(this, "pulseCondition");
        gui.add(this, "copyGcode");
        gui.add(this, "sendGcodeToSim");

        this.loadStl(this.model);
    }

    private storeSettings(): void {
        localStorage.setItem("dicer-settings", JSON.stringify({
            stock: {
                diameterMm: this.stockDiameter,
                lengthMm: this.stockLength,
            },
        }));
    }

    private loadSettings(): void {
        const val = localStorage.getItem("dicer-settings");
        if (!val) {
            return;
        }
        try {
            const obj = JSON.parse(val);
            this.stockDiameter = obj.stock?.diameterMm ?? this.stockDiameter;
            this.stockLength = obj.stock?.lengthMm ?? this.stockLength;
            console.log("Settings loaded", obj);
        } catch {
            console.warn("Broken settings (invalid JSON) found; discarded", val);
        }
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


    /**
     * Load STL model
     * @param fname Model filename
     */
    loadStl(fname: string) {
        const loader = new STLLoader();
        loader.load(
            `../assets/models/${fname}.stl`,
            (geometry: THREE.BufferGeometry) => {
                this.targetGeom = geometry;
                this.recomputeTarget();
            },
            (progress) => {
                console.log('Model loading progress: ', progress);
            },
            (error) => {
                console.error('Model loading error: ', error);
            }
        );
    }

    rotX90() {
        this.targetGeom.rotateX(Math.PI / 2);
        this.recomputeTarget();
    }

    rotY90() {
        this.targetGeom.rotateY(Math.PI / 2);
        this.recomputeTarget();
    }

    private recomputeTarget() {
        const aabb = computeAABB(this.targetGeom);
        const height = aabb.max.z - aabb.min.z;
        const center = aabb.min.clone().add(aabb.max).multiplyScalar(0.5);

        console.log("Model AABB", aabb);
        // shift so that:
        // XY: center of AABB will be set to X=Y=0.
        // Z: bottom surface matches Z=0 plane.
        this.targetGeom.translate(-center.x, -center.y, -aabb.min.z);

        this.aboveWorkSize = height + this.stockTopBuffer;
        this.baseZ = this.stockLength - this.aboveWorkSize;
        this.#updateStockVis();
        this.initPlan(this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);

        const material = new THREE.MeshPhysicalMaterial({
            color: 0xb2ffc8,
            metalness: 0.1,
            roughness: 0.8,
            transparent: true,
            opacity: 0.8,
        });
        this.framework.updateVis("target", [new THREE.Mesh(this.targetGeom, material)]);
    }

    copyGcode() {
        const gcode = generateGcode(this.planPath || [], {
            work: stdWorkPulseCondition,
            grinder: this.pulseCondition,
        });
        navigator.clipboard.writeText(gcode);
        console.log("G-code copied to clipboard");
    }

    sendGcodeToSim() {
        const gcode = generateGcode(this.planPath || [], {
            work: stdWorkPulseCondition,
            grinder: this.pulseCondition,
        });
        const bc = new BroadcastChannel("gcode");
        bc.postMessage(gcode);
        bc.close();
        console.log("G-code sent to sim");
    }
}
