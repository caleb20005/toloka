const navToggle = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('.mobile-menu');
navToggle?.addEventListener('click', () => { const open = mobileMenu.classList.toggle('open'); navToggle.classList.toggle('open', open); navToggle.setAttribute('aria-expanded', open); });
document.querySelectorAll('.mobile-menu a').forEach(link => link.addEventListener('click', () => { mobileMenu.classList.remove('open'); navToggle?.classList.remove('open'); }));
const header = document.querySelector('.site-header');
addEventListener('scroll', () => header?.classList.toggle('scrolled', scrollY > 18), { passive: true });
const observer = new IntersectionObserver((entries) => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }}), { threshold: .12 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
