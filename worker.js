// worker.js

// --- 核心距離計算函數 ---

// 歐幾里德距離 (用於計算 RGB 空間中的顏色差異)
const colorDistance = (r1, g1, b1, r2, g2, b2) => {
    return Math.sqrt(Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2));
};

const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
};

// 1. HSV 判斷邏輯（專為硬邊去背調整）
const isPixelBackgroundHSVHard = (r, g, b, tolerancePercent) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
        if (max === g) hue = 60 * ((b - r) / delta + 2);
        else if (max === r) hue = 60 * ((g - b) / delta + 4);
        else hue = 60 * ((r - g) / delta);
    }
    if (hue < 0) hue += 360;

    const saturation = max === 0 ? 0 : delta / max;
    const value = max / 255;
    
    const toleranceFactor = tolerancePercent / 100;

    // 綠色色相範圍 (H: 60-180)
    const isGreenHue = (hue >= 60 && hue <= 180);
    
    // 設定硬門檻：必須在綠色色相範圍內，並且飽和度和亮度都要夠高 (由 tolerance 控制)
    // 綠幕去背的關鍵是 S 和 V 必須高，且 H 必須在範圍內
    // 這裡使用 toleranceFactor 來放寬 S 和 V 的限制
    const minSat = 0.25 * (1 - toleranceFactor * 0.5); // 讓容許度可以放寬飽和度最低值
    const minVal = 0.35 * (1 - toleranceFactor * 0.5); // 讓容許度可以放寬亮度最低值
    
    const isStandardGreenScreen = isGreenHue && saturation > minSat && value > minVal;
    
    // 額外判斷綠色是否明顯佔優勢 (防止前景的淺色被誤判)
    const isDominantGreen = (g > r + 30) && (g > b + 30) && (g > 80);

    return isStandardGreenScreen || isDominantGreen;
};


// 2. 核心去背邏輯：實現邊緣柔化 (Feathering) - 仍保留給 'global' 模式使用
// 柔化邏輯沒有變動，但不再是預設推薦
const removeBgFeathered = (imgData, targetHex, tolerancePercent, smoothnessPercent) => {
    const data = imgData.data;
    const len = data.length;
    
    const toleranceFactor = tolerancePercent / 100;
    const smoothnessFactor = smoothnessPercent / 100;

    const isGreenScreen = targetHex.toLowerCase() === '#00ff00';
    const targetRgb = isGreenScreen ? null : hexToRgb(targetHex) || {r:0, g:0, b:0};
    const maxDist = 442; 

    for (let i = 0; i < len; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        let similarity = 0; 
        
        if (isGreenScreen) {
            // 對綠幕使用 HSV 邏輯 (使用柔化專用的相似度計算)
            similarity = (isPixelBackgroundHSVHard(r, g, b, 100) ? 1 : 0); // 這裡改用布林值作為硬相似度
        } else {
            const distance = colorDistance(r, g, b, targetRgb.r, targetRgb.g, targetRgb.b);
            similarity = 1 - (distance / maxDist);
        }

        const edgeStart = toleranceFactor;
        const edgeEnd = Math.max(0, edgeStart - smoothnessFactor); 
        
        if (similarity >= edgeStart) {
            data[i+3] = 0; 
        } else if (similarity > edgeEnd) {
            const range = edgeStart - edgeEnd;
            const diff = similarity - edgeEnd;
            let alpha = Math.round(255 * (1 - diff / range));
            data[i+3] = Math.max(0, Math.min(255, alpha)); 
        } else {
            data[i+3] = 255; 
        }
    }
    
    return imgData;
};

// 3. 連通去背 (Flood Fill) 邏輯 - HARD EDGE 模式（最精確地模擬您原來的邏輯）
const removeBgFloodFill = (imgData, w, h, targetHex, tolerancePercent) => {
    const data = imgData.data;
    const isGreenScreen = targetHex.toLowerCase() === '#00ff00';
    const targetRgb = isGreenScreen ? null : hexToRgb(targetHex) || {r:0, g:0, b:0};
    const maxDist = 442;
    const toleranceDist = maxDist * (tolerancePercent / 100);

    const isBackground = (r, g, b) => {
        // 使用硬門檻判斷 (這將決定去背的精確度)
        if (isGreenScreen) {
            // 綠幕使用 HSV 專業硬邊判斷邏輯
            return isPixelBackgroundHSVHard(r, g, b, tolerancePercent);
        } else {
            // 其他顏色使用 RGB 距離判斷
            const distance = colorDistance(r, g, b, targetRgb.r, targetRgb.g, targetRgb.b);
            return distance <= toleranceDist;
        }
    };
    
    // 從四個角落開始向內填充，以處理外圍背景
    const stack = [[0,0], [w-1,0], [0,h-1], [w-1,h-1]];
    const visited = new Uint8Array(w*h);
    
    while(stack.length) {
        const [x, y] = stack.pop();
        const offset = y*w + x;

        if (x < 0 || x >= w || y < 0 || y >= h || visited[offset]) continue;
        visited[offset] = 1;

        const idx = offset * 4;
        
        if (isBackground(data[idx], data[idx+1], data[idx+2])) {
            data[idx+3] = 0; // 硬性設為完全透明
            
            // 向四個方向擴散 (連通性)
            stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
        }
    }
    return imgData;
};

// 4. 侵蝕濾鏡
const applyErosion = (imgData, w, h, strength) => {
    if (strength <= 0) return imgData;

    const data = imgData.data;
    
    for (let k = 0; k < strength; k++) {
        const currentAlpha = new Uint8Array(w * h);
        for(let i=0; i<w*h; i++) currentAlpha[i] = data[i*4+3];

        for (let y = 1; y < h-1; y++) {
            for (let x = 1; x < w-1; x++) {
                const idx = y*w + x;
                
                if (currentAlpha[idx] > 0) {
                    if (currentAlpha[idx-1] === 0 || currentAlpha[idx+1] === 0 || 
                        currentAlpha[idx-w] === 0 || currentAlpha[idx+w] === 0) {
                        data[idx*4+3] = 0; 
                    }
                }
            }
        }
    }
    return imgData;
};

// --- Web Worker Main Listener ---

self.onmessage = function(e) {
    const { id, rawImageData, removalMode, targetColorHex, colorTolerance, erodeStrength, smoothness, width, height } = e.data;
    
    let processedImageData = rawImageData; 
    
    if (removalMode === 'flood') {
        // 連通去背 (Hard Edge) - 應匹配您的舊版水準
        processedImageData = removeBgFloodFill(processedImageData, width, height, targetColorHex, colorTolerance);
    } else {
        // 柔化去背 (Feathering)
        processedImageData = removeBgFeathered(processedImageData, targetColorHex, colorTolerance, smoothness);
    }
    
    // 執行邊緣侵蝕
    processedImageData = applyErosion(processedImageData, width, height, erodeStrength);
    
    // 將結果傳回主執行緒 (Web Worker 加速的核心)
    self.postMessage({ id: id, processedImageData: processedImageData }, [processedImageData.data.buffer]);
};
