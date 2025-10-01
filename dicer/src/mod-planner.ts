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

/**
 * Creates stock mesh visualization spanning [offsetZ, stockHeight + offsetZ].
 * This is intended to be stock visualization UI, rather than accurate representation of its geometry.
 */
const generateStockVis = (stockRadius: number = 7.5, stockHeight: number = 15, offsetZ: number = 0): THREE.Object3D => {
    const geom = generateStockGeom(stockRadius, stockHeight);
    const mat = new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.z = offsetZ;
    return mesh;
};

const generateStockAfterCutVis = (manifold: ManifoldHandle, wasmGeom: WasmGeom): THREE.Object3D => {
    const material = new THREE.MeshPhysicalMaterial({
        color: "green",
        metalness: 0.1,
        roughness: 0.8,
    });
    return new THREE.Mesh(wasmGeom.manifoldToGeometry(manifold), material);
};

/**
 * Creates visualization of target geom by wrapping it.
 */
const generateTargetVis = (geom: THREE.BufferGeometry): THREE.Object3D => {
    const material = new THREE.MeshPhysicalMaterial({
        color: 0xb2ffc8,
        metalness: 0.1,
        roughness: 0.8,
        transparent: true,
        opacity: 0.8,
    });
    return new THREE.Mesh(geom, material);
};


/**
 * Planner class for generating tool paths.
 *
 * This class is not pure function. It's a "module" with UIs and depends on debug stuff.
 * Thus, planner instance should be kept, even when re-running planner from scratch.
 */
export class ModulePlanner implements Module {
    framework: ModuleFramework;

    showStock: boolean = true;
    showTarget: boolean = true;
    showWork: boolean = true;
    showPlanPath: boolean = true;

    planPath: PathSegment[];

    wasmGeom: WasmGeom;

    // Model data
    models: Record<string, string>;
    model: string;
    targetGeom: THREE.BufferGeometry; // target geom in setup coords, after rotation & centering.
    targetHeight: number; // derived from targetGeom

    // Stock configuration
    stockDiameter: number;
    stockLength: number; // max length of the stock
    stockDirtyLength: number; // max length of the dirty (uncertain) part of the stock that needs to be thrown away.

    // operation configuration
    grinderPulseCondition: string = "M4 P150 Q20 R40";
    workPulseCondition: string = "M3 P150 Q20 R50";

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

        // stock state setup
        this.stockDiameter = 15;
        this.stockLength = 20;
        this.stockDirtyLength = 0.5;
        this.loadSettings();
        this.updateStockVis();

        this.framework.registerModule(this);
    }

    /**
     * Add planner-specific GUI controls
     * @param gui GUI instance to add controls to
     */
    addGui(gui: GUI) {
        // Model setup
        gui.add(this, 'model', this.models).onChange((model) => {
            this.framework.updateVis("targ-vg", []);
            this.framework.updateVis("work-vg", []);
            this.framework.updateVis("misc", []);
            this.loadStl(model);
        });
        gui.add(this, "rotX90").name("Rotate 90° around X");
        gui.add(this, "rotY90").name("Rotate 90° around Y");
        gui.add(this, "rotZ90").name("Rotate 90° around Z");

        // Stock config
        gui.add(this, "stockDiameter", 1, 30, 0.1).name("Stock Dia (saved)").onChange(_ => {
            this.storeSettings();
            this.updateStockVis();
        });
        gui.add(this, "stockLength", 1, 30, 0.1).name("Stock Length (saved)").onChange(_ => {
            this.storeSettings();
            this.updateStockVis();
        });
        gui.add(this, "stockDirtyLength", 0, 2, 0.1).onChange(_ => {
            this.updateStockVis();
        });

        // Visibility flags
        gui.add(this, "showStock")
            .onChange(v => this.framework.setVisVisibility("stock", v))
            .listen();
        gui.add(this, "showTarget")
            .onChange(v => this.framework.setVisVisibility("target", v))
            .listen();
        gui.add(this, "showWork")
            .onChange(v => this.framework.setVisVisibility("work", v))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(v => this.framework.setVisVisibility("plan-path-vg", v))
            .listen();

        // Machine operation config
        gui.add(this, "workPulseCondition").name("Pulse (work)");
        gui.add(this, "grinderPulseCondition").name("Pulse (grinder)");

        // G-code gen & sending
        gui.add(this, "generate").name("Generate");
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
     * Generates G-code program and stores into this.planPath.
     */
    async generate() {
        const stockGeom = generateStockGeom(this.stockDiameter / 2, this.stockLength);
        translateGeom(stockGeom, new THREE.Vector3(0, 0, this.stockOffset()));
        const stockManifold = this.wasmGeom.createManifold(stockGeom);
        const targetManifold = this.wasmGeom.createManifold(this.targetGeom);

        const res = await genPathByProjection(
            targetManifold, stockManifold,
            this.wasmGeom, (group, vs, visible) => this.framework.updateVis(group, vs, visible));
        this.planPath = res.path;
        this.framework.updateVis("work", [generateStockAfterCutVis(res.stockAfterCut, this.wasmGeom)], true);
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
                this.recomputeTargetShift();
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
        this.recomputeTargetShift();
    }

    rotY90() {
        this.targetGeom.rotateY(Math.PI / 2);
        this.recomputeTargetShift();
    }

    rotZ90() {
        this.targetGeom.rotateZ(Math.PI / 2);
        this.recomputeTargetShift();
    }

    /**
     * Translate this.targetGeom while retaining its orientation, to lay it on the XY plane of the setup coords.
     * Also updates this.targetHeight property and target vis.
     */
    private recomputeTargetShift(): void {
        const aabb = computeAABB(this.targetGeom);
        const height = aabb.max.z - aabb.min.z;
        const center = aabb.min.clone().add(aabb.max).multiplyScalar(0.5);
        this.targetGeom.translate(-center.x, -center.y, -aabb.min.z);
        this.targetHeight = height;
        this.framework.updateVis("target", [generateTargetVis(this.targetGeom)]);

        // targetHeight change affects stock vis.
        this.updateStockVis();
    }

    /**
     * Update stock visualization.
     */
    private updateStockVis(): void {
        this.framework.updateVis("stock", [generateStockVis(this.stockDiameter / 2, this.stockLength, this.stockOffset())], this.showStock);
    }

    /**
     * Computes Z offset of stock (which originally exists in [0, stockLength]) that makes it fit well to the targetGeom.
     */
    private stockOffset(): number {
        return (this.targetHeight + this.stockDirtyLength) - this.stockLength;
    }

    copyGcode() {
        const gcode = generateGcode(this.planPath || [], {
            work: this.workPulseCondition,
            grinder: this.grinderPulseCondition,
        });
        navigator.clipboard.writeText(gcode);
        console.log("G-code copied to clipboard");
    }

    sendGcodeToSim() {
        const gcode = generateGcode(this.planPath || [], {
            work: this.workPulseCondition,
            grinder: this.grinderPulseCondition,
        });
        const bc = new BroadcastChannel("gcode");
        bc.postMessage(gcode);
        bc.close();
        console.log("G-code sent to sim");
    }
}
