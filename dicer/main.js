import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    initVG, diceSurf, sliceSurfByPlane, sliceContourByLine,
    millLayersZDown, millLayersYDown, millLayersXDown, millLayersYUp, millLayersXUp
} from './geom.js';


const convGeomToSurf = (geom) => {
    if (geom.index === null) {
        return geom.getAttribute("position").array;
    } else {
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

const diceLineAndVisualize = (surf, lineY, lineZ) => {
    // slice specific (Y, Z) line.
    const cont = sliceSurfByPlane(surf, lineZ);
    const bnds = sliceContourByLine(cont, lineY);

    // visualize
    const visContour = createContourVis(cont);
    visContour.position.z = lineZ;

    const visBnd = createBndsVis(bnds);
    visBnd.position.y = lineY;
    visBnd.position.z = lineZ;

    view.updateVis("misc", [visContour, visBnd]);
};


const loadStl = (fname) => {
    const loader = new STLLoader();
    loader.load(
        `models/${fname}.stl`,
        (geometry) => {
            dicer.objSurf = convGeomToSurf(geometry);

            const material = new THREE.MeshPhysicalMaterial({
                color: 0xb2ffc8,
                metalness: 0.1,
                roughness: 0.8,
                transparent: true,
                opacity: 0.1,
            });

            const mesh = new THREE.Mesh(geometry, material)
            view.updateVis("obj", [mesh]);
        },
        (xhr) => {
            console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
        },
        (error) => {
            console.log(error);
        }
    );
};

const generateBlankGeom = () => {
    const blankRadius = 10;
    const blankHeight = 25;
    const geom = new THREE.CylinderGeometry(blankRadius, blankRadius, blankHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, blankHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};



// returns: THREE.Object3D
const createContourVis = (edges) => {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(edges.length / 2 * 3);
    for (let i = 0; i < edges.length / 2; i++) {
        vertices[3 * i + 0] = edges[2 * i + 0];
        vertices[3 * i + 1] = edges[2 * i + 1];
        vertices[3 * i + 2] = 0;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const matEdges = new THREE.LineBasicMaterial({ color: 0x8080a0 });
    const objEdges = new THREE.LineSegments(geom, matEdges);
    const objPoints = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x8080f0, size: 3 }));
    objEdges.add(objPoints);

    return objEdges;
};

// returns: THREE.Object3D
const createBndsVis = (bnds) => {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(bnds.length * 3);
    for (let i = 0; i < bnds.length; i++) {
        vertices[3 * i + 0] = bnds[i];
        vertices[3 * i + 1] = 0;
        vertices[3 * i + 2] = 0;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const matEdges = new THREE.LineBasicMaterial({ color: 0x80a080 });
    const objEdges = new THREE.LineSegments(geom, matEdges);
    const objPoints = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x80f080, size: 3 }));
    objEdges.add(objPoints);

    return objEdges;
};

// returns: THREE.Object3D
const createVgVis = (vg) => {
    const cubeGeom = new THREE.BoxGeometry(dicer.resMm * 0.9, dicer.resMm * 0.9, dicer.resMm * 0.9);

    const num = vg.count();
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), num);
    let instanceIx = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const v = vg.get(ix, iy, iz);
                if (v === 0) {
                    continue;
                }

                const mtx = new THREE.Matrix4();
                mtx.compose(
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res).add(vg.ofs),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v / 255));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }
    return mesh;
};

const generateBlank = () => {
    const blank = new THREE.Mesh(
        generateBlankGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return blank;
};

const generateTool = () => {
    // 25G needle
    const needleExtRadius = 0.51 / 2;
    const needleLength = 25;
    const wireRadius = 0.25 / 2;
    const wireExtrusion = wireRadius * 2;

    const needle = new THREE.Mesh(
        new THREE.CylinderGeometry(needleExtRadius, needleExtRadius, needleLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3 }));
    needle.position.y = needleLength / 2;

    const wire = new THREE.Mesh(
        new THREE.CylinderGeometry(wireRadius, wireRadius, wireExtrusion, 16, 1),
        new THREE.MeshPhysicalMaterial({ color: "red", metalness: 0.9, roughness: 0.7 }));
    needle.add(wire);
    wire.position.y = needleLength / 2 + wireExtrusion / 2;

    return needle;
};


////////////////////////////////////////////////////////////////////////////////
// 3D view

/**
 * Scene is in mm unit. Right-handed, Z+ up.
 */
class View3D {
    constructor() {
        this.init();
        this.visGroups = {};

        this.tool = generateTool();
        this.scene.add(this.tool);

        const blank = generateBlank();
        this.scene.add(blank);
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, 0.1, 150);
        this.camera.position.x = -15;
        this.camera.position.y = -40;
        this.camera.position.z = 20;
        this.camera.up.set(0, 0, 1);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
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


        const gridHelperBottom = new THREE.GridHelper(40, 4);
        const gridHelperTop = new THREE.GridHelper(40, 1);
        this.scene.add(gridHelperBottom);
        this.scene.add(gridHelperTop);
        gridHelperBottom.rotateX(Math.PI / 2);
        gridHelperTop.rotateX(Math.PI / 2);
        gridHelperTop.position.z = 40;

        const axesHelper = new THREE.AxesHelper(8);
        this.scene.add(axesHelper);
        axesHelper.position.set(-19, -19, 0);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);


        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');


        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    updateVis(group, vs) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.scene.remove(v));
        }
        vs.forEach(v => this.scene.add(v));
        this.visGroups[group] = vs;
    }

    setVisVisibility(group, visible) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => v.visible = visible);
        }
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    animate() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}

////////////////////////////////////////////////////////////////////////////////
// GUI

const Model = {
    HELICAL_GEAR: "helical_gear",
    HELICAL_GEAR_STANDING: "helical_gear_standing",
    DICE_TOWER: "dice_tower",
    BENCHY: "benchy_25p",
    BOLT_M3: "M3x10"
};

const dicer = {
    model: Model.HELICAL_GEAR,
    resMm: 0.25,
    lineZ: 1,
    lineY: 0,
    showTarget: false,
    showWork: false,
    objSurf: null,
    millVgs: [],
    dice: () => {
        const surfBlank = convGeomToSurf(generateBlankGeom());

        const workVg = initVG(surfBlank, dicer.resMm);
        const targVg = workVg.clone();
        diceSurf(surfBlank, workVg);
        diceSurf(dicer.objSurf, targVg);

        dicer.millVgs = [];
        //dicer.millVgs.push(millLayersZDown(workVg, targVg));
        dicer.millVgs.push(millLayersYDown(workVg, targVg));
        dicer.millVgs.push(millLayersXDown(workVg, targVg));
        dicer.millVgs.push(millLayersYUp(workVg, targVg));
        dicer.millVgs.push(millLayersXUp(workVg, targVg));
        console.log(`milling done; ${dicer.millVgs.length} steps emitted`);

        view.updateVis("vg-targ", [createVgVis(targVg)]);
        dicer.showTarget = true;

        view.updateVis("vg-work", [createVgVis(workVg)]);
        view.setVisVisibility("vg-work", false);
    },
    diceLine: () => {
        const sf = convGeomToSurf(generateBlankGeom());
        diceLineAndVisualize(dicer.objSurf, dicer.lineY, dicer.lineZ);
    },
    millStep: 0,
    toolX: 0,
    toolY: 0,
    toolZ: 0,
};

function initGui(view) {
    const gui = new GUI();
    gui.add(dicer, 'model', Model).onChange((model) => {
        view.updateVis("vg-targ", []);
        view.updateVis("vg-work", []);
        view.updateVis("misc", []);

        loadStl(model);
    });
    gui.add(dicer, "resMm", [1e-3, 1e-2, 1e-1, 0.25, 0.5, 1]);
    gui.add(dicer, "showTarget").onChange(v => {
        view.setVisVisibility("vg-targ", v);
    }).listen();
    gui.add(dicer, "showWork").onChange(v => {
        view.setVisVisibility("vg-work", v);
    }).listen();
    gui.add(dicer, "dice");

    const sd = gui.addFolder("Slice Debug");
    sd.add(dicer, "lineZ", -10, 50).step(0.1);
    sd.add(dicer, "lineY", -50, 50).step(0.1);
    sd.add(dicer, "diceLine");

    const sim = gui.addFolder("Tool Sim");
    sim.add(dicer, "millStep", 0, 10).step(1).onChange(step => {
        if (0 <= step && step < dicer.millVgs.length) {
            view.updateVis("mill", [createVgVis(dicer.millVgs[step])]);
        } else {
            view.updateVis("mill", []);
        }
    });
    sim.add(dicer, "toolX", -50, 50).step(0.1).onChange(v => view.tool.position.x = v);
    sim.add(dicer, "toolY", -50, 50).step(0.1).onChange(v => view.tool.position.y = v);
    sim.add(dicer, "toolZ", 0, 100).step(0.1).onChange(v => view.tool.position.z = v);

    loadStl(dicer.model);
}

////////////////////////////////////////////////////////////////////////////////
// entry point
const view = new View3D();
initGui(view);
