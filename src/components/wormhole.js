export function initWormhole() {
    const canvas = document.getElementById('wormhole-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    let width, height;
    let stars = [];
    const starCount = 400;
    const speed = 0.05;
    const focalLength = 1000;

    function resize() {
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = width;
        canvas.height = height;
    }

    class Star {
        constructor() {
            this.init();
        }

        init() {
            this.x = (Math.random() - 0.5) * 2000;
            this.y = (Math.random() - 0.5) * 2000;
            this.z = Math.random() * focalLength;
            this.pz = this.z;
            this.color = Math.random() > 0.5 ? '#7c3aed' : '#06b6d4';
        }

        update() {
            this.z -= speed * 100;
            if (this.z < 1) {
                this.init();
                this.z = focalLength;
                this.pz = this.z;
            }
        }

        draw() {
            const sx = (this.x / this.z) * focalLength + width / 2;
            const sy = (this.y / this.z) * focalLength + height / 2;
            
            const px = (this.x / this.pz) * focalLength + width / 2;
            const py = (this.y / this.pz) * focalLength + height / 2;

            ctx.beginPath();
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 1.5 * (1 - this.z / focalLength);
            ctx.moveTo(px, py);
            ctx.lineTo(sx, sy);
            ctx.stroke();

            this.pz = this.z;
        }
    }

    let warpFactor = 1;
    let targetWarpFactor = 1;

    for (let i = 0; i < starCount; i++) {
        stars.push(new Star());
    }

    function animate() {
        const isLight = document.body.classList.contains('light-theme');
        
        // Use a slightly transparent clear to get trails
        const bgColor = getComputedStyle(document.body).getPropertyValue('--bg-color');
        ctx.fillStyle = bgColor;
        ctx.globalAlpha = 0.2; // This creates the trailing effect
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = 1.0;
        
        // Smoothly transition warp factor
        warpFactor += (targetWarpFactor - warpFactor) * 0.05;

        // In light mode, 'lighter' makes things invisible. Use 'multiply' or 'source-over'
        if (isLight) {
            ctx.globalCompositeOperation = 'multiply';
        } else {
            ctx.globalCompositeOperation = 'lighter';
        }
        
        stars.forEach(star => {
            star.update();
            // Scale star movement by warpFactor
            star.z -= speed * 100 * (warpFactor - 1);
            
            // Save original colors to prevent persistent mutation
            const baseColor = star.baseColor || star.color;
            if (!star.baseColor) star.baseColor = baseColor;
            
            // Apply theme-specific color for visibility
            if (isLight) {
                star.color = baseColor === '#7c3aed' ? '#4338ca' : '#0891b2';
            } else {
                star.color = baseColor;
            }
            
            star.draw();
        });
        
        ctx.globalCompositeOperation = 'source-over';
        requestAnimationFrame(animate);
    }

    window.addEventListener('resize', resize);
    resize();
    animate();

    return {
        setWarp: (active) => {
            targetWarpFactor = active ? 10 : 1;
        }
    };
}
