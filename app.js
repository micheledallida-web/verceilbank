document.addEventListener('DOMContentLoaded', () => {
  const menuBtn = document.getElementById('mobileMenuToggle');
  const closeBtn = document.getElementById('closeDrawerBtn');
  const navLinks = document.getElementById('navLinks');
  
  let backdrop = document.getElementById('menuBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'menu-backdrop';
    backdrop.id = 'menuBackdrop';
    document.body.appendChild(backdrop);
  }

  function openMenu() {
    navLinks.classList.add('active');
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden'; 
  }

  function closeMenu() {
    navLinks.classList.remove('active');
    backdrop.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (menuBtn) menuBtn.addEventListener('click', openMenu);
  if (closeBtn) closeBtn.addEventListener('click', closeMenu);
  if (backdrop) backdrop.addEventListener('click', closeMenu);
  
  document.querySelectorAll('.drawer-items .nav-link').forEach(link => {
    link.addEventListener('click', closeMenu);
  });

  // --------------------------------------------------------------------------
  // VERCEL-STYLE HIGHLIGHT WORD ROTATOR ANIMATION
  // --------------------------------------------------------------------------
  const words = ["simple.", "secure.", "seamless.", "effortless."];
  let currentIndex = 0;
  const wordElement = document.getElementById("rotatingWord");

  if (wordElement) {
    setInterval(() => {
      // 1. Animate current highlight word up and out
      wordElement.classList.add("swap-out");

      setTimeout(() => {
        // 2. Advance index and change text
        currentIndex = (currentIndex + 1) % words.length;
        wordElement.textContent = words[currentIndex];

        // 3. Move instantly to bottom start position
        wordElement.classList.remove("swap-out");
        wordElement.classList.add("swap-prepare");

        // 4. Smoothly animate up into center position
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            wordElement.classList.remove("swap-prepare");
          });
        });
      }, 450); // Matches CSS transition duration
    }, 2800); // Rotates every 2.8 seconds
  }
});
