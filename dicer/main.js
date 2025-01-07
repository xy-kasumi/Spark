import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import {
    initVG, initVGForPoints, diceSurf, sliceSurfByPlane, sliceContourByLine,
    resampleVG,
} from './geom.js';

const fontLoader = new FontLoader();
let font = null;

// Apply translation to geometry in-place.
// [in]: THREE.BufferGeometry
// [in]: THREE.Vector3
const translateGeom = (geom, trans) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};


// Get "triangle soup" representation from a geometry.
// [in]: THREE.BufferGeometry
// returns: TypedArray
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


// returns: THREE.BufferGeometry
const generateStockGeom = () => {
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


// [in] VoxelGrid
// [in] label optional string to display on the voxel grid
// returns: THREE.Object3D
const createVgVis = (vg, label = "") => {
    const cubeGeom = new THREE.BoxGeometry(vg.res * 0.9, vg.res * 0.9, vg.res * 0.9);

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
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v / 255));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }

    const meshContainer = new THREE.Object3D();
    meshContainer.add(mesh);
    meshContainer.quaternion.copy(vg.rot);
    meshContainer.position.copy(vg.ofs);

    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
    mesh.add(axesHelper);

    if (label !== "") {
        const textGeom = new TextGeometry(label, {
            font,
            size: 2,
            depth: 0.1,
         });
        const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color: "#222222" }));
        meshContainer.add(textMesh);
    }
    
    return meshContainer;
};


// [in] array of THREE.Vector3, path
// returns: THREE.Object3D
const createPathVis = (path) => {
    const vs = new Float32Array(path.length * 3);
    for (let i = 0; i < path.length; i++) {
        vs[3 * i + 0] = path[i].pos.x;
        vs[3 * i + 1] = path[i].pos.y;
        vs[3 * i + 2] = path[i].pos.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vs, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x808080 });
    return new THREE.Line(geom, mat);
};

// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);

// Creates ring+axis rotational axis visualizer.
// [in] axis THREE.Vector3. rotates around this axis in CCW.
// [in] size number feature size. typically ring radius.
// [in] color THREE.Color
// returns: THREE.Object3D
const createRotationAxisHelper = (axis, size = 1, color = axisColorA) => {
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
    const lToWMat3 = new THREE.Matrix3(
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


// returns: THREE.Object3D
const generateStock = () => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};


// returns: THREE.Object3D
const generateTool = () => {
    const toolOrigin = new THREE.Object3D();

    const baseRadius = 10;
    const baseHeight = 10;

    const needleExtRadius = 1.5 / 2;
    const needleLength = 25;

    const toolBase = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, baseHeight, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8 }));
    toolBase.position.y = -baseHeight / 2;
    toolOrigin.add(toolBase);

    const needle = new THREE.Mesh(
        new THREE.CylinderGeometry(needleExtRadius, needleExtRadius, needleLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3 }));
    needle.position.y = needleLength / 2;

    toolOrigin.add(needle);
    toolOrigin.setRotationFromEuler(new THREE.Euler(0, -Math.PI / 2, Math.PI / 2)); // 2nd elem: B rot -pi/2, 3rd elem: fixed
    toolOrigin.position.x = needleLength + 10;

    const aAxisHelper = createRotationAxisHelper(new THREE.Vector3(0, 1, 0), 2, axisColorA);
    toolOrigin.add(aAxisHelper);

    const bAxisHelper1 = createRotationAxisHelper(new THREE.Vector3(1, 0, 0), 5, axisColorB);
    const bAxisHelper2 = createRotationAxisHelper(new THREE.Vector3(1, 0, 0), 5, axisColorB);
    bAxisHelper1.position.set(1, 0, 0);
    bAxisHelper2.position.set(-1, 0, 0);
    toolOrigin.add(bAxisHelper1);
    toolOrigin.add(bAxisHelper2);

    return toolOrigin;
};


////////////////////////////////////////////////////////////////////////////////
// 3D view

const Model = {
    GT2_PULLEY: "GT2_pulley",
    HELICAL_GEAR: "helical_gear",
    HELICAL_GEAR_STANDING: "helical_gear_standing",
    DICE_TOWER: "dice_tower",
    BENCHY: "benchy_25p",
    BOLT_M3: "M3x10",
};


// Check if a is equal or subset of b.
// [in]: a VoxelGrid
// [in]: b VoxelGrid
// [out]: boolean
const checkIsSubset = (a, b) => {
    const c = b.clone().greaterOrEqual(a);
    return c.count() === c.numX * c.numY * c.numZ;
}

// Apply transformation to AABB, and return the transformed AABB.
// [in] min, max THREE.Vector3 in coordinates A.
// [in] mtx THREE.Matrix4 transforms (A -> B)
// returns: {min: THREE.Vector3, max: THREE.Vector3} in coordinates B.
const transformAABB = (min, max, mtx) => {
    const minB = new THREE.Vector3(1e100, 1e100, 1e100);
    const maxB = new THREE.Vector3(-1e100, -1e100, -1e100);
    for (let i = 0; i < 8; i++) {
        const cubeVertex = new THREE.Vector3(
            (i & 1) ? min.x : max.x,
            (i & 2) ? min.y : max.y,
            (i & 4) ? min.z : max.z,
        ).applyMatrix4(mtx);
        minB.min(cubeVertex);
        maxB.max(cubeVertex);
    }
    return { min: minB, max: maxB };
};


/**
 * Scene is in mm unit. Right-handed, Z+ up.
 */
class View3D {
    constructor() {
        this.init();

        // machine geometries
        this.workOffset = new THREE.Vector3(20, 40, 20); // in machine coords

        this.machineCoord = new THREE.Object3D();
        this.workCoord = new THREE.Object3D();
        this.scene.add(this.machineCoord);
        this.scene.add(this.workCoord);

        // work-coords
        this.visGroups = {};
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.workCoord.add(gridHelperBottom);

        // machine-coords
        this.tool = generateTool();
        this.machineCoord.add(this.tool);

        const machineVis = new THREE.Object3D();
        {
            const opBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(70, 100, 60));
            machineVis.add(new THREE.Box3Helper(opBox, new THREE.Color(0x000000)));

            const wireBox = new THREE.Box3();
            wireBox.setFromCenterAndSize(new THREE.Vector3(30, 15, 30), new THREE.Vector3(1, 20, 1));
            machineVis.add(new THREE.Box3Helper(wireBox, new THREE.Color(0x000000)));

            const axesHelper = new THREE.AxesHelper(10);
            machineVis.add(axesHelper);
            axesHelper.position.set(0.1, 0.1, 0.1); // increase visibility by slight offset

            const textGeom = new TextGeometry("machine", {
                font,
                size: 2,
                depth: 0.1,
            });
            const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color: "#222222" }));
            machineVis.add(textMesh);
        }
        this.machineVis = machineVis;
        this.machineCoord.add(machineVis);

        const cAxisHelper = createRotationAxisHelper(new THREE.Vector3(0, 0, 1), 2, axisColorC);
        cAxisHelper.position.copy(this.workOffset);
        this.machineVis.add(cAxisHelper);

        // machine-state setup
        this.toolLength = 25;
        this.workCRot = 0;
        this.toolARot = 0;
        this.toolBRot = 0;
        this.toolX = 15;
        this.toolY = 15;
        this.toolZ = 50;

        const stock = generateStock();
        this.objStock = stock;
        this.workCoord.add(stock);
        this.model = Model.GT2_PULLEY;
        this.showStockMesh = true;
        this.showTargetMesh = true;

        this.resMm = 0.5;
        this.showWork = true;
        this.showTarget = false;
        this.targetSurf = null;

        this.viewMode = "machine"; // "work";
        this.updateVisTransforms();
        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.showSweepAccess = false;
        this.showSweepSlice = false;
        this.showSweepRemoval = false;
        this.showPlanPath = true;

        this.initGui();
    }

    // Update positions of objects, assuming world coords is what is set by this.viewMode.
    updateVisTransforms() {
        this.machineVis.visible = this.viewMode === "machine";
        this.tool.visible = this.viewMode === "machine";

        this.tool.position.set(this.toolX, this.toolY, this.toolZ);
        this.tool.setRotationFromEuler(new THREE.Euler(0, this.toolBRot - Math.PI / 2, Math.PI / 2)); // TODO: duplicate with init code

        if (this.viewMode === "machine") {
            this.machineCoord.position.copy(this.workOffset.clone().multiplyScalar(-1));
            
            this.workCoord.position.set(0, 0, 0);
            this.workCoord.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.workCRot); //  set(0, 0, 0, 1); // TODO: this must be affected by machineCoord.
        } else {
            this.workCoord.position.set(0, 0, 0);
            this.workCoord.quaternion.set(0, 0, 0, 1);
        }
    }

    initGui() {
        const view = this;
        const loadStl = (fname) => {
            const loader = new STLLoader();
            loader.load(
                `models/${fname}.stl`,
                (geometry) => {
                    // To avoid parts going out of work by numerical error, slightly offset the part geometry.
                    translateGeom(geometry, new THREE.Vector3(0, 0, 0.5));
                    this.targetSurf = convGeomToSurf(geometry);

                    const material = new THREE.MeshPhysicalMaterial({
                        color: 0xb2ffc8,
                        metalness: 0.1,
                        roughness: 0.8,
                        transparent: true,
                        opacity: 0.8,
                    });

                    const mesh = new THREE.Mesh(geometry, material)
                    this.updateVis("target", [mesh]);
                },
                (xhr) => {
                    console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
                },
                (error) => {
                    console.log(error);
                }
            );
        };

        const gui = new GUI();
        gui.add(this, 'model', Model).onChange((model) => {
            this.updateVis("targ-vg", []);
            this.updateVis("work-vg", []);
            this.updateVis("misc", []);
    
            loadStl(model);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.objStock.visible = v;
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.setVisVisibility("target", v);
        }).listen();

        gui.add(this, "resMm", [1e-3, 5e-2, 1e-2, 1e-1, 0.25, 0.5, 1]);
    
        gui.add(this, "initPlan");
        gui.add(this, "genNextSweep");
        gui.add(this, "genNextSweep10");
        gui.add(this, "numSweeps").disable().listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").disable().listen();
        gui.add(this, "showingSweep", 0, this.numSweeps).step(1).listen();
        gui.add(this, "viewMode", ["work", "machine"]).onChange(_ => this.updateVisTransforms());
        gui.add(this, "showTarget")
            .onChange(_ => this.setVisVisibility("targ-vg", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.setVisVisibility("work-vg", this.showWork))
            .listen();
        gui.add(this, "showSweepAccess")
            .onChange(_ => this.setVisVisibility("sweep-access-vg", this.showSweepAccess))
            .listen();
        gui.add(this, "showSweepSlice")
            .onChange(_ => this.setVisVisibility("sweep-slice-vg", this.showSweepSlice))
            .listen();
        gui.add(this, "showSweepRemoval")
            .onChange(_ => this.setVisVisibility("sweep-removal-vg", this.showSweepRemoval))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();
    
        loadStl(this.model);
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, -150, 150);
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

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    initPlan() {
        this.numSweeps = 0;
        this.showingSweep = 0;

        this.stockSurf = convGeomToSurf(generateStockGeom());
        this.workVg = initVGForPoints(this.stockSurf, this.resMm);
        this.targVg = this.workVg.clone();
        diceSurf(this.stockSurf, this.workVg);
        diceSurf(this.targetSurf, this.targVg);
        console.log("stock is large enough", checkIsSubset(this.targVg, this.workVg));

        this.planPath = [];
        this.planner = {
            normalIndex: 0,
        };

        this.updateVis("work-vg", [createVgVis(this.workVg)], this.showWork);
        this.updateVis("targ-vg", [createVgVis(this.targVg)], this.showTarget);
        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);
    }

    genNextSweep10() {
        for (let i = 0; i < 10; i++) {
            const committed = this.genNextSweep();
            if (!committed) {
                break;
            }
        }
    }

    // returns: true if sweep is committed, false if not
    genNextSweep() {
        if (this.workVg === undefined) {
            this.initPlan();
        }

        const candidateNormals = [
            
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
        ];

        // "surface" x canditateNormal
        // compute accessible area from shape x tool base
        //
        // reproject to 0.25mm grid of normal dir as local-Z.
        // compute "access grid"
        //   convolve tool radius in local XY-direction
        //   apply projecting-or in Z- direction
        //   now this grid's empty cells shows accessible locations to start milling from
        // pick the shallowed layer that contains voxels to be removed
        // compute the accesssible voxel in the surface, using zig-zag pattern
        // compute actual path (pre g-code)
        //
        // apply the removal to the work vg (how?)

        const diffVg = this.workVg.clone().sub(this.targVg.clone().saturateFill());
        if (diffVg.count() === 0) {
            console.log("done!");
            return false;
        }

        // Prepare new (rotated) VG for projecting the work.
        // [in] normal THREE.Vector3, world coords. Local Z+ will point normal.
        // returns: VoxelGrid, empty voxel grid
        const initReprojGrid = (normal, res) => {
            // orthogonalize, with given Z-basis.
            const basisZ = normal;
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
            const lToWMat3 = new THREE.Matrix3(
                basisX.x, basisY.x, basisZ.x,
                basisX.y, basisY.y, basisZ.y,
                basisX.z, basisY.z, basisZ.z,
            );

            const lToWQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(lToWMat3));
            const workMin = this.workVg.ofs.clone();
            const workMax = new THREE.Vector3(this.workVg.numX, this.workVg.numY, this.workVg.numZ).multiplyScalar(this.workVg.res).add(workMin);
            
            const wToLMtx = new THREE.Matrix4().compose(
                new THREE.Vector3(0, 0, 0),
                lToWQ.clone().invert(),
                new THREE.Vector3(1, 1, 1));
            const aabbLoc = transformAABB(workMin, workMax, wToLMtx);

            return initVG(aabbLoc, res, lToWQ, false, 5);
        };

        // [in] normal THREE.Vector3, world coords.
        // returns: {path: array<Vector3>, deltaWork: VG, vis: {target: VG, blocked: VG}} | null (if impossible)
        const genPlanarSweep = (normal) => {
            const accesGridRes = this.resMm;
            
            const sweepBlocked = initReprojGrid(normal, accesGridRes);
            const sweepTarget = sweepBlocked.clone();
            const sweepRemoved = sweepBlocked.clone();
            resampleVG(sweepBlocked, this.workVg);
            sweepBlocked.extendByRadiusXY(1.5 / 2);
            sweepBlocked.scanZMaxDesc();

            resampleVG(sweepTarget, diffVg);
            const passMaxZ = sweepTarget.findMaxNonZeroZ();

            // prepare 2D-scan at Z= passMaxZ.
            sweepTarget.filterZ(passMaxZ);

            let minScore = 1e100;
            let minPt = null;
            for (let iy = 0; iy < sweepTarget.numY; iy++) {
                for (let ix = 0; ix < sweepTarget.numX; ix++) {
                    const v = sweepTarget.get(ix, iy, passMaxZ);
                    if (v > 0) {
                        const score = ix + iy;
                        if (score < minScore) {
                            minScore = score;
                            minPt = new THREE.Vector2(ix, iy);
                        }
                    }
                }
            }
            // TODO: VERY FRAGILE
            const access = sweepBlocked.get(minPt.x, minPt.y, passMaxZ + 1);  // check previous layer's access
            const accessOk = access === 0;
            if (!accessOk) {
                return null;
            }
            
            // generate zig-zag
            let isFirstInLine = true;
            let dirR = true; // true: right, false: left
            let currIx = minPt.x;
            let currIy = minPt.y;
            const sweepPath = [];
            while (true) {
                sweepRemoved.set(currIx, currIy, passMaxZ, 255);

                const nextIx = currIx + (dirR ? 1 : -1);
                const nextNeeded = sweepTarget.get(nextIx, currIy, passMaxZ) > 0;
                const upNeeded = sweepTarget.get(currIx, currIy + 1, passMaxZ) > 0;
                const nextAccess = sweepBlocked.get(nextIx, currIy, passMaxZ + 1) === 0;
                const upAccess = sweepBlocked.get(currIx, currIy + 1, passMaxZ + 1) === 0;
                const upOk = upNeeded && upAccess;
                const nextOk = nextNeeded && nextAccess;

                const pathPt = {
                    normal: normal,
                    pos: sweepTarget.centerOf(currIx, currIy, passMaxZ),
                };

                if (isFirstInLine) {
                    sweepPath.push(pathPt);
                    isFirstInLine = false;
                }

                if (!nextOk && !upOk) {
                    sweepPath.push(pathPt);
                    break;
                }
                if (nextOk) {
                    // don't write to path here
                    currIx = nextIx;
                } else {
                    sweepPath.push(pathPt);
                    isFirstInLine = true;
                    dirR = !dirR;
                    currIy++;
                }
                // TODO: tool wear handling
            }

            const deltaWork = this.workVg.clone();
            deltaWork.fill(0);
            sweepRemoved.extendByRadiusXY(1.5 / 2);
            resampleVG(deltaWork, sweepRemoved);

            return {
                path: sweepPath,
                deltaWork: deltaWork,
                vis: {
                    target: sweepTarget,
                    removed: sweepRemoved,
                }
            };
        };

        let sweep = null;
        for (let i = 0; i < candidateNormals.length; i++) {
            sweep = genPlanarSweep(candidateNormals[this.planner.normalIndex]);
            if (sweep) {
                break;
            }
            this.planner.normalIndex = (this.planner.normalIndex + 1) % candidateNormals.length;
        }
        if (sweep === null) {
            console.log("possible sweep exhausted");
            return false;
        }

        console.log(`commiting sweep ${this.numSweeps}`, sweep);

        this.planPath.push(...sweep.path);
        const volBeforeSweep = this.workVg.volume();
        this.workVg.sub(sweep.deltaWork);
        const volAfterSweep = this.workVg.volume();
        this.removedVol += volBeforeSweep - volAfterSweep;
        this.numSweeps++;
        this.showingSweep++;

        this.dumpGcode();

        this.updateVis("sweep-slice-vg", [createVgVis(sweep.vis.target, "sweep-slice")], this.showSweepSlice);
        this.updateVis("sweep-removal-vg", [createVgVis(sweep.vis.removed, "sweep-removal")], this.showSweepRemoval);

        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);
        this.updateVis("work-vg", [createVgVis(this.workVg, "work-vg")], this.showWork);

        const lastPt = this.planPath[this.planPath.length - 1];

        // Order of determination ("IK")
        // 1. Determine B,C axis
        // 2. Determine X,Y,Z axis
        // TODO: A-axis
        // (X,Y,Z) -> B * toolLen = tipPt

        const EPS_ANGLE = 1e-3 / 180 * Math.PI; // 1/1000 degree

        const n = lastPt.normal.clone();
        if (n.z < 0) {
            console.error("Impossible tool normal; path will be invalid", n);
        }

        n.z = 0;
        const bAngle = Math.asin(n.length());
        this.toolBRot = bAngle;
        if (bAngle < EPS_ANGLE) {
            // Pure Z+. Prefer neutral work rot.
            this.workCRot = 0;
        } else {
            this.workCRot = -Math.atan2(n.y, n.x);
        }
        
        const tipPosMachineCoord = lastPt.pos.clone();
        tipPosMachineCoord.applyAxisAngle(new THREE.Vector3(0, 0, 1), this.workCRot);
        tipPosMachineCoord.add(this.workOffset);

        const offsetBaseToTip = new THREE.Vector3(-Math.sin(bAngle), 0, -Math.cos(bAngle)).multiplyScalar(this.toolLength);
        tipPosMachineCoord.sub(offsetBaseToTip);

        this.toolX = tipPosMachineCoord.x
        this.toolY = tipPosMachineCoord.y;
        this.toolZ = tipPosMachineCoord.z;
        this.updateVisTransforms();

        return true;
    }

    dumpGcode() {
        const gcode = [];
        for (let i = 0; i < this.planPath.length; i++) {
            const pt = this.planPath[i];
            const tipPos = pt.pos;
            gcode.push(`G1 X${tipPos.x} Y${tipPos.y} Z${tipPos.z} C${this.workCRot * 180 / Math.PI}`);
        }

        console.log("GCODE", gcode.join("\n"));
    }

    updateVis(group, vs, visible = true) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.workCoord.remove(v));
        }
        vs.forEach(v => {
            this.workCoord.add(v);
            v.visible = visible;
        });
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
// entry point


const loadFont = async () => {
    return new Promise((resolve) => {
        fontLoader.load("./Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

(async () => {
    await loadFont();
    const view = new View3D();
})();
