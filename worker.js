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

// 1. RGB 距離計算
// 回傳實際距離
const isTargetColorRGB = (r, g, b, targetRgb) => {
    return colorDistance(r, g, b, targetRgb.r, targetRgb.g, targetRgb.b);
};

// 2. HSV 相似度計算 (專用於綠幕，回傳相似度分數 0~1)
const isPixelBackgroundHSV = (r, g, b) => {
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
    
    // 色相範圍 (H: 60-180 為綠色)
    const isGreenHue = (hue >= 60 && hue <= 180);

    if (!isGreenHue) return 0; // 色相不對，直接排除
    
    // 返回飽和度作為相似度分數 (純綠幕為高飽和)
    return saturation; 
};


// 3. 核心去背邏輯：實現邊緣柔化 (取代舊的 removeBgGlobal/FloodFill)
const removeBgFeathered = (imgData, targetHex, tolerancePercent, smoothnessPercent) => {
    const data = imgData.data;
    const len = data.length;
    
    // 將百分比轉為範圍值 (0.01 ~ 1)
    const toleranceFactor = tolerancePercent / 100;
    const smoothnessFactor = smoothnessPercent / 100;

    const isGreenScreen = targetHex.toLowerCase() === '#00ff00';
    const targetRgb = isGreenScreen ? null : hexToRgb(targetHex) || {r:0, g:0, b:0};
    const maxDist = 442; // RGB 最大距離

    for (let i = 0; i < len; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        let similarity = 0; // 0: 完全不相似 (前景), 1: 完全相似 (背景)
        
        if (isGreenScreen) {
            // 對綠幕使用 HSV 邏輯
            similarity = isPixelBackgroundHSV(r, g, b); 
        } else {
            // 對其他顏色使用 RGB 距離
            const distance = isTargetColorRGB(r, g, b, targetRgb);
            // 正規化距離為相似度：距離越小，相似度越高
            similarity = 1 - (distance / maxDist);
        }

        // --- 核心柔化處理 ---
        
        // 1. 設定柔化區間
        const edgeStart = toleranceFactor; // 容許度門檻 (相似度達到此值以上完全透明)
        const edgeEnd = Math.max(0, edgeStart - smoothnessFactor); // 柔化區間的終點
        
        if (similarity >= edgeStart) {
            // 相似度夠高 (超過容許度)，完全透明
            data[i+3] = 0; 
        } else if (similarity > edgeEnd) {
            // 處於柔化區間 (edgeEnd < similarity < edgeStart)
            const range = edgeStart - edgeEnd;
            const diff = similarity - edgeEnd;
            
            // 計算 Alpha 值：從 255 平滑過渡到 0
            let alpha = Math.round(255 * (1 - diff / range));
            
            // 設為半透明，消除鋸齒
            data[i+3] = Math.max(0, Math.min(255, alpha)); 
        } else {
            // 相似度低於柔化終點，完全不透明 (視為前景)
            data[i+3] = 255; 
        }
    }
    
    return imgData;
};

// 4. 連通去背 (Flood Fill) 邏輯 (保留以備用)
const removeBgFloodFill = (imgData, w, h, targetHex, tolerancePercent) => {
    const data = imgData.data;
    const isGreenScreen = targetHex.toLowerCase() === '#00ff00';
    const targetRgb = isGreenScreen ? null : hexToRgb(targetHex) || {r:0, g:0, b:0};
    const maxDist = 442;
    const toleranceDist = maxDist * (tolerancePercent / 100);

    const isBackground = (r, g, b) => {
        if (isGreenScreen) {
            const similarity = isPixelBackgroundHSV(r, g, b);
            return similarity >= (tolerancePercent / 100); // 使用 HSV 相似度門檻
        } else {
            const distance = colorDistance(r, g, b, targetRgb.r, targetRgb.g, targetRgb.b);
            return distance <= toleranceDist;
        }
    };
    
    // 從四個角落開始向內填充
    const stack = [[0,0], [w-1,0], [0,h-1], [w-1,h-1]];
    const visited = new Uint8Array(w*h);
    
    while(stack.length) {
        const [x, y] = stack.pop();
        const offset = y*w + x;

        if (x < 0 || x >= w || y < 0 || y >= h || visited[offset]) continue;
        visited[offset] = 1;

        const idx = offset * 4;
        
        if (isBackground(data[idx], data[idx+1], data[idx+2])) {
            data[idx+3] = 0; 
            
            stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
        }
    }
    return imgData;
};

// 5. 侵蝕濾鏡
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
        // 使用連通去背 (無柔化，速度中等，適合中間有洞)
        processedImageData = removeBgFloodFill(processedImageData, width, height, targetColorHex, colorTolerance);
    } else {
        // 使用邊緣柔化去背 (品質較高，適合邊緣平滑)
        processedImageData = removeBgFeathered(processedImageData, targetColorHex, colorTolerance, smoothness);
    }
    
    // 執行邊緣侵蝕
    processedImageData = applyErosion(processedImageData, width, height, erodeStrength);
    
    // 將結果傳回主執行緒 (使用 transferables 加速)
    self.postMessage({ id: id, processedImageData: processedImageData }, [processedImageData.data.buffer]);
};
