// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { ModuleFramework, Module } from './framework.js';
import { ModulePlanner } from './mod-planner.js';
import { computeAABB } from './tracking-voxel.js';
import { visDot } from './debug.js';
import { toTriSoup } from './wasm-geom.js';


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
    initToolLen: number;  // must be larger than actual current tool len to avoid collision
    targToolLen: number; // target tool length after cutting
    wireFeedRate: number;
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
        gui.add(this, "rotX90").name("Rotate 90° around X");
        gui.add(this, "rotY90").name("Rotate 90° around Y");

        gui.add(this, "stockDiameter", 1, 30, 0.1).onChange(_ => {
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "stockLength", 1, 30, 0.1).onChange(_ => {
            this.baseZ = this.stockLength - this.aboveWorkSize;
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);
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
        const aabb = computeAABB(toTriSoup(this.targetGeom));
        const height = aabb.max.z - aabb.min.z;
        const center = aabb.min.clone().add(aabb.max).multiplyScalar(0.5);

        console.log("Model AABB", aabb);
        // shift so that:
        // XY: center of AABB will be set to X=Y=0.
        // Z: bottom surface matches Z=0 plane.
        this.targetGeom.translate(-center.x, -center.y, -aabb.min.z);

        this.targetSurf = toTriSoup(this.targetGeom);

        this.aboveWorkSize = height + this.stockTopBuffer;
        this.baseZ = this.stockLength - this.aboveWorkSize;
        this.#updateStockVis();
        this.modPlanner.initPlan(this.targetSurf, this.targetGeom, this.baseZ, this.aboveWorkSize, this.stockDiameter);

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

        const workPulseCondition = "M3 P150 Q20 R50";

        /*
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
        */

        // normal code
        lines.push("G53"); // machine coords
        lines.push("G28"); // home

        lines.push("G55"); // work coords
        lines.push(`G0 X0 Y0 Z60`);
        prevX = 0;
        prevY = 0;
        prevZ = 60;

        for (let i = 0; i < planPath.length; i++) {
            const pt = planPath[i];
            if (prevSweep !== pt.sweep) {
                lines.push(`; sweep-${pt.sweep}`);
                prevSweep = pt.sweep;
            }

            let gcode = [];
            if (pt.type === "remove-work") {
                if (prevType !== pt.type) {
                    lines.push(workPulseCondition);
                }
                gcode.push("G1");
            } else if (pt.type === "remove-tool") {
                if (prevType !== pt.type) {
                    lines.push(this.pulseCondition);
                }
                gcode.push("G1");
            } else if (pt.type === "move-out" || pt.type === "move-in" || pt.type === "move") {
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
            /*
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
            */

            if (gcode.length > 1) {
                lines.push(gcode.join(" "));
            }
        }

        lines.push(`; end`);
        lines.push(`G0 Z60`); // pull
        lines.push(`G53`); // machine coords

        //lines.push(`M103`);

        lines.push("");
        return lines.join("\n");
    }
}
