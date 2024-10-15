import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';

const conds = {
    cylRadiusMm: 1,
    sphRadiusMm: 1,
};

////////////////////////////////////////////////////////////////////////////////
// GUI

function computeCaps() {
    const epsilon = 80 * 8.85e-12; // F/m
    const area = 1e-6; // m^2
    const cylRadius = conds.cylRadiusMm * 1e-3; // m
    const cylLength = 1e-3; // m
    const sphRadius = conds.sphRadiusMm * 1e-3; // m

    const pprintDist = (d) => {
        return `${d * 1e6}um`;
    };

    const pprintCap = (cap) => {
        if (cap < 1e-9) {
            return `${(cap * 1e12).toPrecision(3)}pF`;
        } else if (cap < 1e-6) {
            return `${(cap * 1e9).toPrecision(3)}nF`;
        } else {
            return `${(cap * 1e6).toPrecision(3)}uF`;
        }
    };

    // two parallel plates
    const capPlate = (d) => {
        return epsilon * area / d;
    };

    // two parallel cylinders
    const capCyl = (d) => {
        const centerD = d + 2 * cylRadius;
        return epsilon * Math.PI * cylLength / Math.acosh(centerD / (2 * cylRadius));
    };

    // sphere vs wall
    const capSphere = (d) => {
        const centerD = d + sphRadius;
        const D = centerD / sphRadius;

        let accum = 0;
        for (let i = 1; i < 50; i++) {
            const t = Math.log(D + Math.sqrt(D * D - 1));
            accum += Math.sinh(t) / Math.sinh(i * t);
        }
        return epsilon * 4 * Math.PI * sphRadius * accum;
    };

    const dists = [1e-6, 2e-6, 5e-6, 10e-6, 20e-6, 50e-6, 100e-6, 200e-6, 500e-6];

    console.log("======");
    dists.forEach((d) => {
        console.log(pprintDist(d),
            pprintCap(capPlate(d)), 
            " / Cyl", pprintCap(capCyl(d)), (capCyl(d) / capPlate(d)).toFixed(2),
            " / Sph", pprintCap(capSphere(d)), (capSphere(d) / capPlate(d)).toFixed(2));
    });
    
}

function initGui() {
    const gui = new GUI();
    gui.add(conds, "cylRadiusMm", 0, 5).listen().decimals(2).onChange(() => computeCaps());
    gui.add(conds, "sphRadiusMm", 0, 5).listen().decimals(2).onChange(() => computeCaps());

    computeCaps();
}


////////////////////////////////////////////////////////////////////////////////
// entry point

initGui();
