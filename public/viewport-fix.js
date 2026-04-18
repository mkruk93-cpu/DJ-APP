(function() {
  function setVhVar() {
    var vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', vh + 'px');
  }
  setVhVar();
  window.addEventListener('resize', setVhVar);
  window.addEventListener('orientationchange', setVhVar);
  // On keyboard open/close (Android), try to update as well
  window.addEventListener('focusin', setVhVar);
  window.addEventListener('focusout', setVhVar);
})();