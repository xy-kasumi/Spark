import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { CoordSys, GCodeLine, parseGCodeProgram, tracePath } from './gcode.js';

const fontLoader = new FontLoader();
let font: any = null;

const generateStockGeom = (): THREE.BufferGeometry => {
    const stockRadius = 7.5;
    const stockHeight = 15;
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);

// Creates ring+axis rotational axis visualizer.
// [in] axis THREE.Vector3. rotates around this axis in CCW.
// [in] size number feature size. typically ring radius.
// [in] color THREE.Color
const createRotationAxisHelper = (axis: THREE.Vector3, size: number = 1, color: THREE.Color = axisColorA): THREE.Object3D => {
    const NUM_RING_PTS = 32;

    /////
    // contsutuct axis & ring out of line segments

    // Generate as Z+ axis, scale=1 and rotate & re-scale later.
    const buffer = new THREE.BufferGeometry();
    const pts = [];
    // add axis
    pts.push(0, 0, -1);
    pts.push(0, 0, 1);
    // add ring
    for (let i = 0; i < NUM_RING_PTS; i++) {
        const angle0 = 2 * Math.PI * i / NUM_RING_PTS;
        const angle1 = 2 * Math.PI * (i + 1) / NUM_RING_PTS;
        pts.push(Math.cos(angle0), Math.sin(angle0), 0);
        pts.push(Math.cos(angle1), Math.sin(angle1), 0);
    }
    buffer.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const lineSegs = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color }));

    /////
    // construct direction cones
    const geom = new THREE.ConeGeometry(0.1, 0.2);
    const coneMat = new THREE.MeshBasicMaterial({ color });
    const cone0 = new THREE.Mesh(geom, coneMat);
    const cone1 = new THREE.Mesh(geom, coneMat);

    const localHelper = new THREE.Object3D();
    localHelper.add(lineSegs);
    localHelper.add(cone0);
    cone0.position.set(0.99, 0, 0);

    localHelper.add(cone1);
    cone1.scale.set(1, -1, 1);
    cone1.position.set(-0.99, 0, 0);

    ///// 
    // scale & rotate

    // create orthonormal basis for rotation.
    const basisZ = axis.normalize();
    let basisY;
    const b0 = new THREE.Vector3(1, 0, 0);
    const b1 = new THREE.Vector3(0, 1, 0);
    if (b0.clone().cross(basisZ).length() > 0.3) {
        basisY = b0.clone().cross(basisZ).normalize();
    } else {
        basisY = b1.clone().cross(basisZ).normalize();
    }
    const basisX = basisY.clone().cross(basisZ).normalize();

    // init new grid
    const lToWMat3 = new THREE.Matrix3();
    lToWMat3.set(
        basisX.x, basisY.x, basisZ.x,
        basisX.y, basisY.y, basisZ.y,
        basisX.z, basisY.z, basisZ.z,
    );

    const helper = new THREE.Object3D();
    helper.add(localHelper);

    localHelper.scale.set(size, size, size);
    localHelper.applyMatrix4(new THREE.Matrix4().identity().setFromMatrix3(lToWMat3));
    return helper;
};


const generateStock = (): THREE.Object3D => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};

// Generate tool visualization with tool base origin = origin. tool is pointing towards Z-.
const generateTool = (toolLength: number): THREE.Object3D => {
    const toolOrigin = new THREE.Object3D();

    const baseRadius = 10;
    const baseHeight = 10;

    const toolRadius = 3 / 2;

    // note: cylinder geom is Y direction and centered. Need to rotate and shift.

    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, baseHeight, 6, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8 }));
    base.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    base.position.z = baseHeight / 2;
    toolOrigin.add(base);

    const tool = new THREE.Mesh(
        new THREE.CylinderGeometry(toolRadius, toolRadius, toolLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3 }));
    tool.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    tool.position.z = -toolLength / 2;
    toolOrigin.add(tool);

    const aAxisHelper = createRotationAxisHelper(new THREE.Vector3(0, 0, -1), 2, axisColorA); // TODO: is this polarity correct?
    toolOrigin.add(aAxisHelper);

    return toolOrigin;
};

type ColorMode = "type" | "dist" | "coordsys";

/**
 * Create visualization for g-code path.
 */
const createGCodePathVis = (program: GCodeLine[], colorMode: ColorMode, offsets: Record<CoordSys, THREE.Vector3>): { vis: THREE.Object3D, legends: string[] } => {
    const blocks = program.filter(l => l.block !== undefined).map(l => l.block);
    const path = tracePath(blocks, offsets);

    const colmap = (t: number): THREE.Color => {
        const fromCol = new THREE.Color(1, 0, 0);
        const toCol = new THREE.Color(0, 0, 1);
        return fromCol.clone().lerp(toCol, t);
    };

    const coordCols: Record<CoordSys, THREE.Color> = {
        "machine": new THREE.Color("black"),
        "grinder": new THREE.Color("blue"),
        "work": new THREE.Color("red"),
        "toolsupply": new THREE.Color("green"),
    };

    const segs = [];
    const segCols = [];
    for (const seg of path.segments) {
        segs.push(seg.src, seg.dst);

        if (colorMode === "type") {
            const segCol = new THREE.Color(seg.segType === "G0" ? "blue" : "red");
            segCols.push(segCol, segCol);
        } else if (colorMode === "dist") {
            const srcCol = colmap(seg.srcDist / path.totalLen);
            const dstCol = colmap(seg.dstDist / path.totalLen);
            segCols.push(srcCol, dstCol);
        } else if (colorMode === "coordsys") {
            const segCol = coordCols[seg.coordSys];
            segCols.push(segCol, segCol);
        }
    }

    let legends: string[];
    if (colorMode === "type") {
        legends = ["Blue: G0", "Red: G1"];
    } else if (colorMode === "dist") {
        legends = ["Red: Begin", `Blue: End(${path.totalLen.toFixed(1)}mm)`];
    } else if (colorMode === "coordsys") {
        legends = ["Black: machine / Blue: Grinder", "Red: Work / Green: ToolSupply"];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs.flatMap(v => [v.x, v.y, v.z])), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segCols.flatMap(c => [c.r, c.g, c.b])), 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true });
    const vis = new THREE.LineSegments(geom, mat);

    return { vis, legends };
};

const machineOffsets: Record<CoordSys, THREE.Vector3> = {
    "machine": new THREE.Vector3(0, 0, 0),
    "grinder": new THREE.Vector3(-58, 76, -73),
    "work": new THREE.Vector3(-57, 10, -89),
    "toolsupply": new THREE.Vector3(-16, 98, -57),
};

////////////////////////////////////////////////////////////////////////////////
// 3D view

/**
 * Scene is in mm unit. Right-handed, X+ up, machine coords.
 */
class View3D {
    // 3D view basis
    scene: THREE.Scene;
    camera: any;
    renderer: THREE.WebGLRenderer;
    container: HTMLElement;
    controls: OrbitControls;
    stats: any;

    // Communication & G-code
    gcodeChannel: BroadcastChannel;
    gcode: GCodeLine[] = [];

    // G-code UI
    receiveBroadcast: boolean = true;
    totalGcodeLines: number = 0;

    // Visualizer control UIs
    colorMode: ColorMode = "type";
    colorLegend1: string = "Blue: G0";
    colorLegend2: string = "Red: G1";
    applyToolOffset: boolean = false;
    toolOffset: number = 50;

    // Dynamic visualization
    pathVis: THREE.Object3D = null;

    constructor() {
        this.init();

        const tool = generateTool(50);
        this.scene.add(tool);

        const workOriginVis = new THREE.AxesHelper(15);
        workOriginVis.position.copy(machineOffsets["work"]);
        this.scene.add(workOriginVis);

        this.initGui();

        this.gcodeChannel = new BroadcastChannel("gcode");
        this.gcodeChannel.onmessage = (e) => {
            if (this.receiveBroadcast) {
                this.importGCode(e.data);
            } else {
                console.log(`broadcast (size=${e.data.length}) ignored`);
            }
        };
    }

    initGui(): void {
        const gui = new GUI();

        gui.add(this, "receiveBroadcast");
        gui.add(this, "pasteFromClipboard");

        gui.add(this, "totalGcodeLines").disable().listen();
        gui.add(this, "colorMode").options(["type", "dist", "coordsys"]).listen().onChange(() => {
            if (this.gcode.length > 0) {
                this.updatePathVisualization();
            }
        });

        gui.add(this, "colorLegend1").disable().listen();
        gui.add(this, "colorLegend2").disable().listen();

        gui.add(this, "applyToolOffset").listen().onChange(() => this.setPathVisOffset());
        gui.add(this, "toolOffset", 0, 70).step(1).listen().onChange(() => this.setPathVisOffset());
    }

    private setPathVisOffset(): void {
        const offset = this.applyToolOffset ? new THREE.Vector3(0, 0, -this.toolOffset) : new THREE.Vector3(0, 0, 0);
        if (this.pathVis) {
            this.pathVis.position.copy(offset);
        }
    }

    private setCameraFrustumFromWindow(): void {
        const aspect = window.innerWidth / window.innerHeight;
        this.camera.left = -25 * aspect;
        this.camera.right = 25 * aspect;
        this.camera.top = 25;
        this.camera.bottom = -25;
        this.camera.updateProjectionMatrix();
    }

    init(): void {
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -300, 300);
        this.setCameraFrustumFromWindow();
        this.camera.position.x = 15;
        this.camera.position.y = 40;
        this.camera.position.z = 20;
        this.camera.up.set(1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        this.container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    pasteFromClipboard(): void {
        navigator.clipboard.readText().then(text => {
            this.importGCode(text);
        });
    }

    private updatePathVisualization(): void {
        const { vis, legends } = createGCodePathVis(this.gcode, this.colorMode, machineOffsets);

        if (this.pathVis) {
            this.scene.remove(this.pathVis);
        }
        this.pathVis = vis;
        this.scene.add(vis);

        this.colorLegend1 = legends[0];
        this.colorLegend2 = legends[1];
    }

    private importGCode(gcodeText: string) {
        const { lines, errors } = parseGCodeProgram(gcodeText);
        if (errors.length > 0) {
            console.error(`G-code parse errors:\n${errors.join("\n")}`);
            return;
        }

        this.gcode = lines;
        this.totalGcodeLines = this.gcode.length;

        this.updatePathVisualization();
    }

    onWindowResize(): void {
        this.setCameraFrustumFromWindow();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate(): void {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}


////////////////////////////////////////////////////////////////////////////////
// entry point

const loadFont = async () => {
    return new Promise<void>((resolve) => {
        fontLoader.load("./assets/Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

(async () => {
    await loadFont();
    const view = new View3D();
})();
