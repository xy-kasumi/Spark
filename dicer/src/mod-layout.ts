// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { ModuleFramework, Module } from './framework.js';
import { ModulePlanner } from './mod-planner.js';
import { computeAABB } from './cpu-geom.js';
import { generateGcode } from './gcode.js';
import { generateStockGeom } from './plan.js';

const generateStockVis = (stockRadius: number = 7.5, stockHeight: number = 15, baseZ: number = 0): THREE.Object3D => {
    const geom = generateStockGeom(stockRadius, stockHeight);
    const mat = new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.z = -baseZ;
    return mesh;
};

const stdWorkPulseCondition = "M3 P150 Q20 R50";

/**
 * Module that controls model loading, laying out the model & work, and sending out G-code.
 */
export class ModuleLayout implements Module {
    framework: ModuleFramework;

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

    // Planning module
    modPlanner: ModulePlanner;

    constructor(framework: ModuleFramework, modPlanner: ModulePlanner) {
        this.framework = framework;
        this.modPlanner = modPlanner;

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
        gui.add(this, "rotX90").name("Rotate 90° around X");
        gui.add(this, "rotY90").name("Rotate 90° around Y");

        gui.add(this, "stockDiameter", 1, 30, 0.1).onChange(_ => {
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "stockLength", 1, 30, 0.1).onChange(_ => {
            this.baseZ = this.stockLength - this.aboveWorkSize;
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);
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
        this.modPlanner.initPlan(this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);

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
        const gcode = generateGcode(this.modPlanner.planPath || [], {
            work: stdWorkPulseCondition,
            grinder: this.pulseCondition,
        });
        navigator.clipboard.writeText(gcode);
        console.log("G-code copied to clipboard");
    }

    sendGcodeToSim() {
        const gcode = generateGcode(this.modPlanner.planPath || [], {
            work: stdWorkPulseCondition,
            grinder: this.pulseCondition,
        });
        const bc = new BroadcastChannel("gcode");
        bc.postMessage(gcode);
        bc.close();
        console.log("G-code sent to sim");
    }
}
