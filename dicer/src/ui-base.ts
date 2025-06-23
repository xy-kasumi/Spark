// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ui-base provides {@link ModuleFramework} class & {@link Module} interface,
 * which is a UI framework that provides a single 3D view and lil-gui.
 */
import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from '../vendor/n8ao/N8AO.js';
import { debug } from './debug.js';

/**
 * Interface for modules that can be registered with ModuleFramework.
 * Modules must call {@link ModuleFramework.registerModule} at the end of the constructor.
 */
export interface Module {
    addGui(gui: any): void;
    animateHook?(): void;
}

/**
 * Framework for modules by combining three.js canvas & lil-gui.
 * Scene is in mm unit. Right-handed, X+ up. Work-coordinates.
 */
export class ModuleFramework {
    // Three.js core objects
    camera: any;
    renderer: any;
    scene: any;
    composer: any;
    controls: any;
    stats: any;
    container: any;

    // Visualization management
    visGroups: any;

    // Debug logging
    vlogDebugs: any[];
    vlogErrors: any[];
    lastNumVlogErrors: number;
    vlogDebugEnable: boolean;
    vlogDebugShow: boolean;

    // Rendering settings
    renderAoRadius: number;
    renderDistFallOff: number;
    renderAoItensity: number;
    renderAoScreenRadius: boolean;

    // Module registry
    private modules: Array<Module> = [];
    private gui: any;

    constructor() {
        // Initialize basis
        this.init();

        this.visGroups = {};

        this.vlogDebugs = [];
        this.vlogErrors = [];
        this.lastNumVlogErrors = 0;

        // Visually log debug info.
        // [in] obj: THREE.Object3D
        debug.vlog = (obj) => {
            if (this.vlogDebugs.length > 1000000) {
                console.warn("vlog: too many debugs, cannot log more");
                return;
            }
            this.vlogDebugs.push(obj);
            this.addVis("vlog-debug", [obj], this.vlogDebugShow);
        };

        // Visually log errors.
        // [in] obj: THREE.Object3D
        debug.vlogE = (obj) => {
            if (this.vlogErrors.length > 1000000) {
                console.warn("vlogE: too many errors, cannot log more");
                return;
            }
            this.vlogErrors.push(obj);
            this.scene.add(obj);
        };

        // Setup extra permanent visualization
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.scene.add(gridHelperBottom);

        this.vlogDebugEnable = true;
        this.vlogDebugShow = false;

        this.renderAoRadius = 5;
        this.renderDistFallOff = 1.0;
        this.renderAoItensity = 5;
        this.renderAoScreenRadius = false;

        // Initialize GUI
        this.gui = new GUI();

        // Add framework-specific debug controls
        this.gui.add(this, "vlogDebugEnable").onChange(v => {
            debug.log = v;
        });
        this.gui.add(this, "vlogDebugShow").onChange(v => {
            this.updateVis("vlog-debug", this.vlogDebugs, v);
        });
        this.gui.add(this, "clearVlogDebug");
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, 1, 150);
        this.camera.position.x = 15;
        this.camera.position.y = 40;
        this.camera.position.z = 20;
        this.camera.up.set(1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x808080); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        const n8aoPass = new N8AOPass(this.scene, this.camera, width, height);
        // We want "AO" effect to take effect at all scales, even though they're physically wrong.
        n8aoPass.configuration.screenSpaceRadius = true;
        n8aoPass.configuration.aoRadius = 64;
        n8aoPass.configuration.distanceFalloff = 0.2;
        n8aoPass.configuration.intensity = 5;
        this.composer.addPass(n8aoPass);

        const outputPass = new OutputPass();
        this.composer.addPass(outputPass);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        this.container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    clearVlogDebug() {
        this.vlogDebugs = [];
        this.updateVis("vlog-debug", this.vlogDebugs, this.vlogDebugShow);
    }

    /**
     * Register a module and set up its GUI
     */
    registerModule(module: Module) {
        this.modules.push(module);

        // Call addGui if the module implements it
        if (module.addGui) {
            module.addGui(this.gui);
        }
    }

    /**
     * Visualization management
     */
    addVis(group: string, vs: Array<THREE.Object3D>, visible: boolean = true) {
        if (!this.visGroups[group]) {
            this.visGroups[group] = [];
            this.visGroups[group].visible = visible;
        }
        for (let v of vs) {
            this.visGroups[group].push(v);
            this.scene.add(v);
            v.visible = visible;
        }
    }

    updateVis(group: string, vs: Array<THREE.Object3D>, visible: boolean = true) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.scene.remove(v));
        }
        this.visGroups[group] = vs;
        for (let v of vs) {
            this.scene.add(v);
            v.visible = visible;
        }
    }

    setVisVisibility(group: string, visible: boolean) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => v.visible = visible);
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        // Call animateHook on all registered modules
        for (const module of this.modules) {
            if (module.animateHook) {
                module.animateHook();
            }
        }

        const numVlogErrors = this.vlogErrors.length;
        if (numVlogErrors != this.lastNumVlogErrors) {
            console.log(`Number of vlog errors: ${numVlogErrors}`);
            this.lastNumVlogErrors = numVlogErrors;
        }

        this.controls.update();
        this.composer.render();
        this.stats.update();
    }
}