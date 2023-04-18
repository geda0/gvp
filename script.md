
in a 2d canvas I Created an html5 canvas full screen black page. with random cheerful multi-colored high-resolution slowly glowing shooting stars in the background
the starts are shiny and have a glow effect
cheerful multi-colored  slowly glowing shooting stars
the stars are randomly generated still at first, then they start glowing slowly, and randomly shoot off the screen
here is my code:

        var canvas = document.getElementById('canvas');

        function calculateNumStars(width, height, cores) {
            const area = width * height;
            const scaleFactor = cores / 4; // Adjust this value to scale the number of stars based on performance
            const baseStars = 717; // Base number of stars for a smaller screen
            return Math.floor((area / (1920 * 1080)) * baseStars * scaleFactor);
        }

        function initStars(numStars) {
            stars = [];
            for (var i = 0; i < numStars; i++) {
                stars[i] = new Star();
            }
        }
        const cores = window.navigator.hardwareConcurrency || 4;


        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            centerX = canvas.width / 2;
            centerY = canvas.height / 2;
            fl = canvas.width;
            numStars = calculateNumStars(canvas.width, canvas.height, cores);
            initStars(numStars);
        }

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        var c = canvas.getContext('2d');
        var numStars = calculateNumStars(canvas.width, canvas.height, cores);
        console.log(`Number of stars: ${numStars}`);
        var stars = [];
        var size = 1;
        var fl = canvas.width;
        var centerX = canvas.width / 2;
        var centerY = canvas.height / 2;
        var baseSpeed = 1;

        function randomColor() {
            return 'hsl(' + Math.random() * 360 + ', 100%, ' + (Math.random() * 20 + 50) + '%)';
        }

        for (var i = 0; i < numStars; i++) {
            stars[i] = new Star();
        }

        function throttle(func, limit) {
            let lastFunc;
            let lastRan;
            return function () {
                const context = this;
                const args = arguments;
                if (!lastRan) {
                    func.apply(context, args);
                    lastRan = Date.now();
                } else {
                    clearTimeout(lastFunc);
                    lastFunc = setTimeout(function () {
                        if ((Date.now() - lastRan) >= limit) {
                            func.apply(context, args);
                            lastRan = Date.now();
                        }
                    }, limit - (Date.now() - lastRan));
                }
            };
        }

        function Star() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.z = Math.random() * canvas.width;
            this.color = randomColor();
            this.size = Math.random() / 2;

            this.move = function () {
                var speed = baseSpeed + (canvas.width - this.z) / canvas.width * 4;
                this.z = this.z - speed;

                if (this.z <= 0 || this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
                    this.z = canvas.width;
                    this.x = Math.random() * canvas.width;
                    this.y = Math.random() * canvas.height;
                    this.color = randomColor();
                }
            }

            this.show = function () {
                var x, y, s;
                x = (this.x - centerX) * (fl / this.z);
                x = x + centerX;

                y = (this.y - centerY) * (fl / this.z);
                y = y + centerY;

                s = this.size * (fl / this.z);

                this.glow = (canvas.width - this.z) / canvas.width * 12;

                var gradient = c.createRadialGradient(x, y, 0, x, y, s * (1.5 + this.glow / 10));
                gradient.addColorStop(0, this.color);
                gradient.addColorStop(1, 'transparent');

                c.beginPath();
                c.fillStyle = gradient;
                c.arc(x, y, s * (1.5 + this.glow / 10), 0, Math.PI * 2);
                c.fill();
            }
        }

        function draw() {
            c.fillStyle = 'rgba(0, 0, 0, 0.25)';
            c.fillRect(0, 0, canvas.width, canvas.height);
            for (var i = 0; i < numStars; i++) {
                stars[i].show();
                stars[i].move();
            }
        }

        function update() {
            draw();
            window.requestAnimationFrame(update);
        }

        const throttledUpdate = throttle(update, 1000 / 120);
        throttledUpdate();
--END



In a 3d canvas, I want you to do exactly the same. I want the end result to look exactly like my 2d canvas looks and animates.. with random cheerful multi-colored high-resolution slowly glowing shooting stars in the background
the starts are shiny and have a glow effect
the stars are randomly generated still at first, then they start glowing slowly, and randomly shoot off the screen

keep the stars direction as it used to be
I want the original shooting stars and glowing effects
Use these libraries:


    <script src="https://cdnjs.cloudflare.com/ajax/libs/tween.js/18.6.4/tween.umd.min.js"></script>
    <script async src="https://unpkg.com/es-module-shims@1.6.3/dist/es-module-shims.js"></script>
    <script type="importmap">
        {
            "imports": {
                "three": "https://unpkg.com/three@0.150.1/build/three.module.js",
                "three/addons/": "https://unpkg.com/three@0.150.1/examples/jsm/"
            }
        }
    </script>

    <script type="module">
        import * as THREE from 'three';




v2-----

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass";
import { AfterimagePass } from "three/examples/jsm/postprocessing/AfterimagePass";

const ShootingStars = () => {
  const containerRef = useRef();

  useEffect(() => {
    const container = containerRef.current;

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 4000);
    camera.position.z = 100;

    const scene = new THREE.Scene();

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const afterimagePass = new AfterimagePass();
    afterimagePass.uniforms["damp"].value = 0.95;
    composer.addPass(afterimagePass);

    const stars = [];

    const onWindowResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    };

    const calculateNumStars = (width, height, cores) => {
      const area = width * height;
      const scaleFactor = cores / 4;
      const baseStars = 17;
      return Math.floor((area / (1920 * 1080)) * baseStars * scaleFactor);
    };

    const randomColor = () => {
      return new THREE.Color(`hsl(${Math.random() * 360}, 100%, ${Math.random() * 20 + 50}%)`);
    };

    const createStar = () => {
      const geometry = new THREE.SphereGeometry(Math.random() / 4, 32, 32);
      const material = new THREE.MeshBasicMaterial({ color: randomColor(), transparent: true, opacity: 0 });
      const star = new THREE.Mesh(geometry, material);
      star.position.set(Math.random() * 300 - 150, Math.random() * 300 - 150, Math.random() * -6000 - 1000);
      scene.add(star);

      const glowGeometry = new THREE.SphereGeometry(1, 32, 32);
      const glowMaterial = new THREE.MeshBasicMaterial({ color: star.material.color, transparent: true, opacity: 0 });
      const glow = new THREE.Mesh(glowGeometry, glowMaterial);
      star.add(glow);
      star.glow = glow;

      return star;
    };

    const updateStars = () => {
      for (let i = 0; i < stars.length; i++) {
        let star = stars[i];
        let speed = 0.001 + (6000 - star.position.z) / 6000 * 3;
        star.position.z += speed;

        let fadeInDistance = -5500;
        let shootDistance = -100;

        if (star.position.z > fadeInDistance && star.position.z < shootDistance) {
          let progress = (star.position.z - fadeInDistance) / (shootDistance - fadeInDistance);
          star.material.opacity = Math.min(progress, 1);
        }

        if (star.position.z >= 100 || star.position.x < -150 || star.position.x > 150 || star.position.y < -150 || star.position.y > 150) {
          star.position.set(Math.random() * 300 - 150, Math.random() * 300 - 150, Math.random() * -6000 - 1000);
          star.material.color = randomColor();
          star.glow.material.color = star.material.color;
          star.material.opacity = 0;
        }

        star.glow.material.opacity = Math.sin((star.position.z + 6000) / 6000 * Math.PI) * 0.4;
        star.glow.scale.set(6 + star.glow.material.opacity * 3, 6 + star.glow.material.opacity * 3, 6 + star.glow.material.opacity * 3);
      }
    };

    const animate = () => {
      requestAnimationFrame(animate);
      updateStars();
      composer.render();
    };

    const init = () => {
      window.addEventListener("resize", onWindowResize, false);

      let numStars = calculateNumStars(window.innerWidth, window.innerHeight, window.navigator.hardwareConcurrency || 4);
      for (let i = 0; i < numStars; i++) {
        stars.push(createStar());
      }

      animate();
    };

    init();

    return () => {
      window.removeEventListener("resize", onWindowResize, false);
      renderer.dispose();
    };

  }, []);

  return <div ref={containerRef} />;
};

export default ShootingStars;
enhance the glowing effect to look like real stars glowing. specially from afar when the glow is really big covering the star itself
