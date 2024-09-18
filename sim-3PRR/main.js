import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.168.0/+esm";

const canvas = document.getElementById('mechanismCanvas');
const canvasIn = document.getElementById('inputSpaceCanvas');
const canvasOut = document.getElementById('outputSpaceCanvas');

const sliders = [
    document.getElementById('slider1'),
    document.getElementById('slider2'),
    document.getElementById('slider3')
];

const linkLength = 50;
const effectorLength = 25;

let eLPrev = null;
let eRPrev = null;
const samples = [];

let chart = null;


function computePositions(inputs) {
    // V2.x : Z, V2.y : X
    const p1 = new THREE.Vector2(inputs[0], 0);
    const p2 = new THREE.Vector2(inputs[1], 0);
    const p3 = new THREE.Vector2(inputs[2], 0);
    const eL = solveTriangle(p1, linkLength, p2, linkLength, eLPrev || new THREE.Vector2(50, -50));
    if (eL === null) {
        return { links: [] };
    }
    eLPrev = eL;

    const eR = solveTriangle(eL, effectorLength, p3, linkLength, eRPrev || new THREE.Vector2(50, -50));
    if (eR === null || eR.y > 0 || eR.x < eL.x) {
        return { links: [] };
    }
    eRPrev = eR;

    const delta = eR.clone().sub(eL).normalize();

    samples.push({
        i0: inputs[0],
        i1: inputs[1],
        i2: inputs[2],
        x: eL.x,
        y: eL.y,
        t: Math.atan2(delta.y, delta.x) * 180 / Math.PI,
    });

    return {
        links: [
            { p: p1, q: eL },
            { p: p2, q: eL },
            { p: p3, q: eR },
            { p: eL, q: eR },
        ],
    };
}

// Finds a find that's lenP from p, and lenQ from q.
// If multiple solutions exists, return the one closest to near.
// If no solution exists, return null.
// p, q, near: THREE.Vector2
// lenP, lenQ: number
function solveTriangle(p, lenP, q, lenQ, near) {
    const d = q.clone().sub(p).length();
    if (lenP + lenQ < d || Math.abs(lenP - lenQ) > d) return null;

    const a = (lenP * lenP - lenQ * lenQ + d * d) / (2 * d);
    const h = Math.sqrt(lenP * lenP - a * a);

    const pq = q.clone().sub(p).normalize();
    const perpendicular = new THREE.Vector2(-pq.y, pq.x);

    const midpoint = p.clone().add(pq.clone().multiplyScalar(a));
    const sol1 = midpoint.clone().add(perpendicular.clone().multiplyScalar(h));
    const sol2 = midpoint.clone().sub(perpendicular.clone().multiplyScalar(h));

    return sol1.distanceTo(near) < sol2.distanceTo(near) ? sol1 : sol2;
}

function render(positions) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    try {
        ctx.save();

        ctx.scale(1, -1);
        ctx.scale(4, 4);

        const gridSize = 10;
        ctx.strokeStyle = '#eee';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
            ctx.moveTo(0, -i * gridSize);
            ctx.lineTo(100, -i * gridSize);
            ctx.moveTo(i * gridSize, 0);
            ctx.lineTo(i * gridSize, -100);
        }
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        positions.links.forEach(link => {
            ctx.beginPath();
            ctx.moveTo(link.p.x, link.p.y);
            ctx.lineTo(link.q.x, link.q.y);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(link.p.x, link.p.y, 2, 0, 2 * Math.PI);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(link.q.x, link.q.y, 2, 0, 2 * Math.PI);
            ctx.fill();
        });
    }
    finally {
        ctx.restore();
    }
}


function renderOutput(samples) {
    const ctx = canvasOut.getContext('2d');
    ctx.clearRect(0, 0, canvasOut.width, canvasOut.height);

    ctx.fillStyle = 'black';
    samples.forEach(sample => {
        ctx.beginPath();
        ctx.arc(sample.y + 100, sample.t / 180 * 100 + 100, 1, 0, 2 * Math.PI);
        ctx.fill();
    });
}


function renderInput(samples) {
    const ctx = canvasIn.getContext('2d');
    ctx.clearRect(0, 0, canvasIn.width, canvasIn.height);

    ctx.fillStyle = 'black';
    samples.forEach(sample => {
        ctx.beginPath();
        ctx.arc(sample.i1 + 100, sample.i2 + 100, 1, 0, 2 * Math.PI);
        ctx.fill();
    });
}

function update() {
    const inputs = sliders.map(slider => parseFloat(slider.value));
    const positions = computePositions(inputs);
    if (positions.links.length === 0) {
        return false;
    }
    render(positions);
    renderInput(samples);
    renderOutput(samples);
    refreshChart(samples);
    return true;
}

sliders.forEach(slider => slider.addEventListener('input', update));
update(); // Initial render

document.getElementById("resetButton").addEventListener("click", () => {
    samples.clear();
});

const playN = 50;
let playIx0 = 0;
let playIx1 = 0;

function execStep() {
    sliders[0].value = 30;
    sliders[2].value = 1 + 140 * (playIx0 / playN);
    sliders[1].value = 31 + 140 * (playIx1 / playN);
    const success = update();
    if (success) {
        playIx0++;
    } else {
        playIx0 = 0;
        playIx1++;
    }
    
    if (playIx0 >= playN) {
        playIx0 = 0;
        playIx1++;
    }
    if (playIx1 >= playN) {
        playIx1 = 0;
        return;
    }
    setTimeout(execStep, 5);
}

document.getElementById("playButton").addEventListener("click", () => {
    execStep();
});


Highcharts.setOptions({
    colors: [
        'rgba(5,141,199,0.5)'
    ]
});


function refreshChart(samples) {
    if (!chart) {
        return;
    }
    //chart.series[0].setData(samples.map(s => [s.t, s.y]));
    const s = samples[samples.length - 1];
    chart.series[0].addPoint([s.t, s.y]);
}

const series = [{
    name: 'TY',
    id: 'TY',
    marker: {
        symbol: 'circle'
    }
},];

chart = Highcharts.chart('container', {
    chart: {
        type: 'scatter',
        zooming: {
            type: 'xy'
        },
    },
    title: {
        text: 'Output Space',
    },
    xAxis: {
        title: {
            text: 'θ'
        },
        labels: {
            format: '{value}°'
        },
        min: -120,
        max: 120,
        startOnTick: true,
        endOnTick: true,
        showLastLabel: true
    },
    yAxis: {
        title: {
            text: 'Y'
        },
        labels: {
            format: '{value} mm'
        },
        min: 0,
        max: 60,
    },
    legend: {
        enabled: true
    },
    plotOptions: {
        scatter: {
            marker: {
                radius: 2.5,
                symbol: 'circle',
                states: {
                    hover: {
                        enabled: true,
                        lineColor: 'rgb(100,100,100)'
                    }
                }
            },
            states: {
                hover: {
                    marker: {
                        enabled: false
                    }
                }
            },
            jitter: {
                x: 0.005
            }
        }
    },
    series
});
console.log(chart);