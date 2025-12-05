// worker.js

// --- 輔助函數 ---

const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
};

// --- 優化的背景移除演算法 ---

// 1. 核心去背邏輯：實現邊緣柔化 (Feathering) - 優化版本
const removeBgFeathered = (imgData, targetHex, tolerancePercent, smoothnessPercent) => {
    const data = imgData.data;
    const len = data.length;
    
    const toleranceFactor = tolerancePercent / 100;
    const smoothnessFactor = smoothnessPercent / 100;
    const edgeStart = toleranceFactor;
    const edgeEnd = Math.max(0, edgeStart - smoothnessFactor);
    const range = edgeStart - edgeEnd;

    const isGreenScreen = targetHex.toLowerCase() === '#00ff00';
    
    if (isGreenScreen) {
        // 優化：綠幕處理 - 內聯化所有邏輯，避免函數呼叫
        for (let i = 0; i < len; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            
            // 內聯相似度計算
            const distG = Math.abs(g - 255);
            const distRB = Math.abs(r - 0) + Math.abs(b - 0);
            const score = (distG * 0.5) + distRB;
            const similarity = 1 - (score / 442);
            
            // 內聯 alpha 計算
            if (similarity >= edgeStart) {
                data[i+3] = 0; 
            } else if (similarity > edgeEnd) {
                const diff = similarity - edgeEnd;
                data[i+3] = Math.round(255 * (1 - diff / range));
            } else {
                // 前景像素保持完全不透明
                data[i+3] = 255;
            }
        }
    } else {
        // 優化：RGB 顏色匹配 - 使用平方距離避免 sqrt
        const target = hexToRgb(targetHex) || {r:0, g:0, b:0};
        const targetR = target.r, targetG = target.g, targetB = target.b;
        const maxDistSq = 442 * 442; // 使用平方值
        
        for (let i = 0; i < len; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            
            // 內聯距離計算 (使用平方避免 sqrt)
            const dr = r - targetR, dg = g - targetG, db = b - targetB;
            const distanceSq = dr*dr + dg*dg + db*db;
            const similarity = 1 - Math.sqrt(distanceSq / maxDistSq);
            
            // 內聯 alpha 計算
            if (similarity >= edgeStart) {
                data[i+3] = 0; 
            } else if (similarity > edgeEnd) {
                const diff = similarity - edgeEnd;
                data[i+3] = Math.round(255 * (1 - diff / range));
            } else {
                // 前景像素保持完全不透明
                data[i+3] = 255;
            }
        }
    }
    
    return imgData;
};

// 2. 連通去背 (Flood Fill) 邏輯 - 優化版本
const removeBgFloodFill = (imgData, w, h, targetHex, tolerancePercent) => {
    const data = imgData.data;
    const isGreenScreen = targetHex.toLowerCase() === '#00ff00';
    
    // 預先計算所有常量
    const toleranceFactor = tolerancePercent / 100;
    const greenPurityMultiplier = 1.2 * (1 - toleranceFactor * 0.5);
    const baseSat = 0.5;
    const baseVal = 0.5;
    const minSat = Math.max(0.1, baseSat * (1 - toleranceFactor * 0.5));
    const minVal = Math.max(0.1, baseVal * (1 - toleranceFactor * 0.5));
    
    let targetR, targetG, targetB, toleranceDistSq;
    if (!isGreenScreen) {
        const target = hexToRgb(targetHex) || {r:0, g:0, b:0};
        targetR = target.r;
        targetG = target.g;
        targetB = target.b;
        const maxDist = 442;
        const toleranceDist = maxDist * toleranceFactor;
        toleranceDistSq = toleranceDist * toleranceDist; // 使用平方避免 sqrt
    }
    
    // 從四個角落開始向內填充，以處理外圍背景
    const stack = [[0,0], [w-1,0], [0,h-1], [w-1,h-1]];
    const visited = new Uint8Array(w*h);
    
    while(stack.length) {
        const [x, y] = stack.pop();
        const offset = y*w + x;

        if (x < 0 || x >= w || y < 0 || y >= h || visited[offset]) continue;
        visited[offset] = 1;

        const idx = offset * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        
        let isBg = false;
        
        if (isGreenScreen) {
            // 內聯綠幕判斷邏輯 (避免函數呼叫)
            // 快速檢測：綠色通道必須明顯高於紅藍通道
            const isGreenDominant = (g > r * greenPurityMultiplier) && (g > b * greenPurityMultiplier);
            
            if (isGreenDominant) {
                // 額外快速判斷：明顯的綠色優勢
                const isDominantGreen = (g > r + 30) && (g > b + 30) && (g > 80);
                
                if (isDominantGreen) {
                    isBg = true;
                } else {
                    // 只有在需要時才計算 HSV (較昂貴的運算)
                    const max = Math.max(r, g, b);
                    const min = Math.min(r, g, b);
                    const delta = max - min;
                    
                    if (delta !== 0) {
                        let hue = 0;
                        if (max === g) hue = 60 * ((b - r) / delta + 2);
                        else if (max === r) hue = 60 * ((g - b) / delta + 4);
                        else hue = 60 * ((r - g) / delta);
                        if (hue < 0) hue += 360;
                        
                        const saturation = delta / max;
                        const value = max / 255;
                        
                        const isGreenHue = (hue >= 60 && hue <= 180);
                        isBg = isGreenHue && saturation >= minSat && value >= minVal;
                    }
                }
            }
        } else {
            // 內聯 RGB 距離判斷 (使用平方避免 sqrt)
            const dr = r - targetR, dg = g - targetG, db = b - targetB;
            isBg = (dr*dr + dg*dg + db*db) <= toleranceDistSq;
        }
        
        if (isBg) {
            data[idx+3] = 0; // 硬性設為完全透明
            
            // 向四個方向擴散 (連通性)
            stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
        }
    }
    return imgData;
};

// 3. 侵蝕濾鏡 - 優化版本：只處理邊緣像素
const applyErosion = (imgData, w, h, strength) => {
    if (strength <= 0) return imgData;

    const data = imgData.data;
    
    for (let k = 0; k < strength; k++) {
        // 只複製 alpha 通道
        const currentAlpha = new Uint8Array(w * h);
        for(let i = 0; i < w * h; i++) {
            currentAlpha[i] = data[i*4+3];
        }

        // 優化：只處理邊緣像素，跳過已透明的像素
        for (let y = 1; y < h-1; y++) {
            for (let x = 1; x < w-1; x++) {
                const idx = y*w + x;
                
                // 跳過已透明的像素
                if (currentAlpha[idx] === 0) continue;
                
                // 檢查 4 方向鄰居（上下左右）
                if (currentAlpha[idx-1] === 0 || 
                    currentAlpha[idx+1] === 0 || 
                    currentAlpha[idx-w] === 0 || 
                    currentAlpha[idx+w] === 0) {
                    data[idx*4+3] = 0;
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
        // 連通去背 (Hard Edge) - 請使用此模式
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
