Create an html5 canvas full screen black page. with random cheerful multi-colored high-resolution slowly glowing shooting stars in the background
the starts are shiny and have a glow effect
the stars are randomly generated still at first, then they start glowing slowly, and randomly shoot off the screen in random directions

some code to get started
function getRandom(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}			
var canvas = document.getElementById('starfield'),
context = canvas.getContext('2d'),
stars = 600,
colorrange = [0,60,240];
for (var i = 0; i < stars; i++) {
var x = Math.random() * canvas.offsetWidth;
y = Math.random() * canvas.offsetHeight,
radius = Math.random() * 1.2,
hue = colorrange[getRandom(0,colorrange.length - 1)],
sat = getRandom(50,100);
context.beginPath();
context.arc(x, y, radius, 0, 360);
context.fillStyle = "hsl(" + hue + ", " + sat + "%, 88%)";
context.fill();
}