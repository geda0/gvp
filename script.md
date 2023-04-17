
I want to change the animations of the content to feel like the stars, coming in from afar
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Marwan Elgendy - The Computerist">
    <title>ME - Marwan Elgendy - The Computerist</title>
    <link rel="shortcut icon" href="favicon.ico" type="image/x-icon">

    <style>
        body {
            background-color: #000000;
            font-family: "Roboto", sans-serif;
            color: #f5f5f5;
            margin: 0;
            padding: 0;
        }

        header {
            background-color: rgba(44, 44, 44, 0.9);
            position: fixed;
            width: 100%;
            z-index: 100;
        }

        nav {
            width: 100%;
            z-index: 1000;
            position: fixed;
        }

        nav ul {
            display: flex;
            justify-content: space-around;
            list-style-type: none;
            padding: 15px;
            background-color: #1a1a1a1a;
        }

        nav a {
            color: #f5f5f5;
            text-decoration: none;
            font-weight: bold;
        }

        nav a:hover {
            color: #6a0dad;
        }

        section {
            padding: 100px 50px;
            text-align: center;
            min-height: 100vh;
            overflow-y: auto;
            transition: transform 1s ease;
        }

        h1,
        h2,
        h3 {
            margin-bottom: 30px;
            text-shadow: 2px 1px 2px #000;
            line-height: 34px;
            margin: 0 auto;
            white-space: nowrap;
        }

        .project {
            margin: 20px 0;
            background-color: #5b1739;
            padding: 15px;
            border-radius: 20px;
            box-shadow: -8px 8px 8px rgba(0, 0, 0, 0.5), 8px 8px 5px rgba(0, 0, 0, 0.4);
        }

        footer {
            background-color: #1a1a1a;
            color: #fff;
            padding-bottom: 7px;
            text-align: center;
            position: fixed;
            bottom: 0;
            left: 0;
            width: 100%;
            z-index: 999;
        }

        footer p {
            margin: 0;
        }

        .canvas-container {
            top: 0;
            left: 0;
            min-height: 700px;
            min-width: 500px;
            overflow: auto;
        }

        #home {
            position: absolute;
            top: 0;
        }

        a:visited {
            color: rgb(147 157 227);
        }

        a {
            color: #9d9dbe;
        }

        img {
            width: 200px;
        }

        #load {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            position: relative;
        }

        canvas {
            position: fixed;
            z-index: -1;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
        }

        #playgroundContent.visible+#load {
            padding-top: 70px;
            margin-top: 0;
            transition: margin-top 0.5s;
        }

        .hidden {
            opacity: 0;
            visibility: hidden;
            height: 0;
            transition: opacity 0.5s, visibility 0.5s, height 0.5s;
        }

        .visible {
            opacity: 1;
            visibility: visible;
            height: auto;
        }

        #contentWrapper {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            transition: all 1s ease;
            transform: translateY(20vh);
        }


        #playgroundContent.visible+#load {
            margin-top: 0;
            transition: margin-top 1s ease;
        }

        #playgroundContent {
            z-index: 100;
        }

        .hidden {
            opacity: 0;
            visibility: hidden;
            height: 0;
            transition: opacity 1s ease, visibility 1s ease, height 1s ease;
        }

        .visible {
            opacity: 1;
            visibility: visible;
            height: auto;
        }

        section#projects {
            margin-top: 299px;
        }

        .section-invisible {
            display: none;
        }


        /* Media queries for responsive design */
        @media (max-width: 767px) {
            nav ul {
                flex-direction: column;
            }

            section {
                padding: 80px 25px;
            }

            h1,
            h2,
            h3 {
                font-size: 24px;
            }

            img {
                width: 150px;
            }
        }
    </style>
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-EYTRKC93DL"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag() { dataLayer.push(arguments); }
        gtag('js', new Date());

        gtag('config', 'G-EYTRKC93DL');
    </script>
</head>

<body>
    <nav>
        <ul>
            <li><a href="#home" id="homeNav" class="section-invisible">Home</a></li>
            <li><a href="#playground" id="playgroundNav">Playground</a></li>
        </ul>
    </nav>
    <main>
        <canvas id="canvas"></canvas>
        <div id="contentWrapper">
            <div id="load">
                <section id="home">
                    <h2>Hello, Welcome to my space..<br />
                        <br />
                        My name is Marwan Elgendy
                        <br /> I am a Software Architect
                    </h2>
                </section>
                <div id="playgroundContent" class="hidden">
                    <section id="projects" class="hidden section-invisible">
                        <h3>Projects -in progress-</h3>
                        <div class="project">
                            <img src="gvp.png" alt="GVP">
                            <h4>Generative Video Platform</h4>
                            <a href="https://gvp-tv.marwanelgendy.link/" target="_blank">gvp.marwanelgendy.link/</a>
                        </div>
                        <div class="project">
                            <img src="day1.png" alt="Day 1">
                            <h4>Project Day 1</h4>
                            <a href="https://day1.marwanelgendy.link/" target="_blank">meta.marwanelgendy.link/</a>
                        </div>
                        <!-- Add more projects as needed -->
                    </section>
                </div>
            </div>
        </div>
    </main>

    <script>

        function sendPageView(event) {
            gtag('event', 'click', {
                'event_category': 'Link Click',
                'event_label': event.target.href,
                'transport_type': 'beacon'
            });
        }
        var canvas = document.getElementById('canvas');
        document.getElementById("playgroundNav").addEventListener("click", function (event) {
            document.getElementById("playgroundContent").classList.remove("hidden");
            document.getElementById("playgroundContent").classList.add("visible");
            document.getElementById("projects").classList.remove("hidden");
            document.getElementById("projects").classList.add("visible");
            document.getElementById("contentWrapper").style.transform = "translateY(0)";
            this.classList.add("section-invisible");
            document.getElementById("homeNav").classList.remove("section-invisible");
            document.getElementById("projects").classList.remove("section-invisible");
            sendPageView(event);
        });

        /* Restore the home section when the home button is clicked to the middle of the screen */
        document.getElementById("homeNav").addEventListener("click", function (event) {
            document.getElementById("playgroundContent").classList.remove("visible");
            document.getElementById("playgroundContent").classList.add("hidden");
            document.getElementById("projects").classList.remove("visible");
            document.getElementById("projects").classList.add("hidden");
            document.getElementById("contentWrapper").style.transform = "translateY(20vh)";
            document.getElementById("playgroundNav").classList.remove("section-invisible");
            this.classList.add("section-invisible");
            document.getElementById("projects").classList.add("section-invisible");
            sendPageView(event);
        });


        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            centerX = canvas.width / 2;
            centerY = canvas.height / 2;
            fl = canvas.width;
            for (var i = 0; i < numStars; i++) {
                stars[i].x = Math.random() * canvas.width;
                stars[i].y = Math.random() * canvas.height;
                stars[i].z = Math.random() * canvas.width;
            }
        }


        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        var c = canvas.getContext('2d');
        var numStars = 717;
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

        function Star() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.z = Math.random() * canvas.width;
            this.color = randomColor();
            this.size = Math.random() / 2;
            this.glow = 0;
            this.glowDirection = 1;

            this.move = function () {
                var speed = baseSpeed + (canvas.width - this.z) / canvas.width * 4;
                this.z = this.z - speed;
                if (this.z <= 0) {
                    this.z = canvas.width;
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
            c.fillStyle = 'rgba(0, 0, 0, 0.2)'; // Lower alpha for motion blur effect
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

        update();

    </script>

    <footer>
        <p>© 2023 ME. All rights reserved.</p>
        <p><a href="https://www.linkedin.com/in/marwan-elgendy/">LinkedIn</a> | <a
                href="mailto:marwan.gendy@gmail.com">marwan.gendy@gmail.com</a></p>
    </footer>
</body>

</html>