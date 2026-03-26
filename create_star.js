const { Jimp } = require('jimp');

async function createStar() {
    const size = 64;
    const image = new Jimp({ width: size, height: size, color: 0x00000000 });
    
    const cx = size/2, cy = size/2;
    const outerR = size/2 * 0.9;
    const innerR = size/2 * 0.4;
    
    function pointInPolygon(point, vs) {
        let x = point[0], y = point[1];
        let inside = false;
        for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
            let xi = vs[i][0], yi = vs[i][1];
            let xj = vs[j][0], yj = vs[j][1];
            let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    let starPts = [];
    for(let i=0; i<10; i++){
        let r = (i%2 === 0) ? outerR : innerR;
        let angle = Math.PI * 2 * i / 10 - Math.PI / 2;
        starPts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (pointInPolygon([x, y], starPts)) {
                image.setPixelColor(0xFFD700FF, x, y);
            }
        }
    }
    await image.write("public/star.png");
    console.log("star.png created");
}
createStar();
