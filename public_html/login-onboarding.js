(() => {
  const params = new URLSearchParams(location.search);
  const referralCode = params.get('ref');
  const requested = params.get('returnTo') || '';
  const permittedReturn = /^(?:Homepage|Home|history|savings|Loans|Referals|Testimonials|withdrawal|status|cashflow|collector|wallet|withdrawal-requests|registrations|referral-program)\.html(?:#[a-z-]+)?$/i;
  // Only approved local pages can be used after login, preventing an arbitrary
  // returnTo URL from becoming an open redirect.
  const safeReturn = permittedReturn.test(requested) ? requested : 'Homepage.html';
  const state = { mode: 'login', step: 1 };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function showMessage(target, text, type = 'error') {
    target.textContent = text;
    target.className = `form-message ${type}`;
    target.setAttribute('role', type === 'error' ? 'alert' : 'status');
    target.setAttribute('aria-live', 'assertive');
  }

  function clearMessage(target) {
    target.textContent = '';
    target.className = 'form-message';
  }

  function updateCountryPresentation() {
    const code = $('#countryCode').value;
    $('#phone').placeholder = code === '254' ? '712 345 678' : '(555) 123-4567';
    $('#phoneHelp').textContent = code === '254' ? 'Use a 9-digit Kenyan mobile number.' : 'Use a 10-digit US mobile number.';
  }

  function normalizedPhone(code, number) {
    let digits = String(number || '').replace(/\D/g, '');
    if (code === '254' && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.startsWith(code) && ((code === '1' && digits.length === 11) || (code === '254' && digits.length === 12))) return digits;
    return `${code}${digits}`;
  }

  function validPhone(phone) {
    return /^1\d{10}$/.test(phone) || /^254\d{9}$/.test(phone);
  }

  function validDateOfBirth(value) {
    if (!value) return false;
    const birthday = new Date(`${value}T00:00:00`);
    const today = new Date();
    let age = today.getFullYear() - birthday.getFullYear();
    const beforeBirthday = today.getMonth() < birthday.getMonth() || (today.getMonth() === birthday.getMonth() && today.getDate() < birthday.getDate());
    if (beforeBirthday) age -= 1;
    return age >= 18 && age < 120;
  }

  function saveSession(data) {
    localStorage.setItem('token', data.token);
    localStorage.setItem('userId', String(data.userId));
    localStorage.setItem('userPhone', data.phone);
    localStorage.setItem('referralCode', data.referralCode || '');
    localStorage.setItem('totalEarned', String(data.totalEarned || 0));
    localStorage.setItem('expectedEarning', String(data.expectedEarning || 0));
    localStorage.setItem('savingsBalance', String(data.savingsBalance || 0));
    if (data.aiTimers) localStorage.setItem('aiTimers', JSON.stringify(data.aiTimers));
    if (data.workTimers) localStorage.setItem('workTimers', JSON.stringify(data.workTimers));
    if (data.mpesaSubmissions) localStorage.setItem('mpesaSubmissions', JSON.stringify(data.mpesaSubmissions));
    if (data.vpsRoutingNoticeRequired) sessionStorage.setItem('vpsRoutingNoticePendingUserId', String(data.userId));
  }

  function setMode(mode) {
    state.mode = mode;
    $$('.mode-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('#loginScreen').hidden = mode !== 'login';
    $('#registerScreen').hidden = mode !== 'register';
    clearMessage($('#loginMessage'));
    clearMessage($('#registerMessage'));
  }

  function openAuth(mode) {
    $('#roleChooser').hidden = true;
    $('#authPanel').classList.add('show');
    setMode(mode);
    history.replaceState(null, '', `${location.pathname}${location.search}#account`);
  }

  function goToStep(next) {
    state.step = Math.min(6, Math.max(1, next));
    $$('.wizard-step').forEach((section) => {
      const active = Number(section.dataset.step) === state.step;
      section.hidden = !active;
      section.classList.toggle('active', active);
    });
    $('#stepCounter').textContent = `Step ${state.step} of 6`;
    $('#progressBar').style.width = `${(state.step / 6) * 100}%`;
    $('#previousStep').hidden = state.step === 1;
    $('#nextStep').hidden = state.step === 6;
    $('#createAccount').hidden = state.step !== 6;
    clearMessage($('#registerMessage'));
    $('#registerScreen').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function selectedRadio(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
  }

  function validateStep(step) {
    const error = $('#registerMessage');
    const value = (id) => $(`#${id}`).value.trim();
    if (step === 1) {
      const phone = normalizedPhone($('#countryCode').value, $('#phone').value);
      if (!value('firstName') || !value('lastName')) return showMessage(error, 'Enter your first and last name.'), false;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email'))) return showMessage(error, 'Enter a valid email address.'), false;
      if (!value('referralCode')) return showMessage(error, 'Paste the referral code from your inviter to continue.'), false;
      if (!validPhone(phone)) return showMessage(error, 'Enter a valid phone number for the selected country.'), false;
      if ($('#password').value.length < 8) return showMessage(error, 'Use a password with at least 8 characters.'), false;
      if ($('#password').value !== $('#confirmPassword').value) return showMessage(error, 'Your passwords do not match.'), false;
    }
    if (step === 2 && (!value('addressLine1') || !value('addressLine2') || !value('city') || !value('region') || !value('country') || !value('postalCode'))) return showMessage(error, 'Complete both address lines, city, region, country, and postal code.'), false;
    if (step === 3) {
      if (!validDateOfBirth($('#birthDate').value)) return showMessage(error, 'You must be at least 18 years old to join Toloka.'), false;
      if (selectedRadio('workEligibility') !== 'yes' || selectedRadio('accountUse') !== 'yes') return showMessage(error, 'You must confirm work eligibility and personal account use to continue.'), false;
    }
    if (step === 4) {
      if (!$('#expertiseFields input:checked') || !value('primaryRole') || !value('experienceLevel')) return showMessage(error, 'Choose at least one expertise area and complete your role and experience.'), false;
    }
    if (step === 5 && (!selectedRadio('availability') || !value('languages') || !selectedRadio('updates'))) return showMessage(error, 'Complete your availability, languages, and communication preference.'), false;
    if (step === 6 && (!$('#termsAccepted').checked || !$('#profileAccurate').checked)) return showMessage(error, 'You must agree to the Terms and confirm that your information is accurate.'), false;
    clearMessage(error);
    return true;
  }

  function profilePayload() {
    return {
      phone: normalizedPhone($('#countryCode').value, $('#phone').value),
      password: $('#password').value,
      referredBy: $('#referralCode').value.trim(),
      firstName: $('#firstName').value.trim(),
      lastName: $('#lastName').value.trim(),
      email: $('#email').value.trim().toLowerCase(),
      addressLine1: $('#addressLine1').value.trim(),
      addressLine2: $('#addressLine2').value.trim(),
      city: $('#city').value.trim(),
      region: $('#region').value.trim(),
      country: $('#country').value,
      postalCode: $('#postalCode').value.trim(),
      birthDate: $('#birthDate').value,
      workEligibility: selectedRadio('workEligibility'),
      expertise: $$('#expertiseFields input:checked').map((input) => input.value),
      primaryRole: $('#primaryRole').value.trim(),
      experienceLevel: $('#experienceLevel').value,
      availability: selectedRadio('availability'),
      languages: $('#languages').value.trim(),
      opportunityUpdates: selectedRadio('updates') === 'yes',
      termsAccepted: $('#termsAccepted').checked,
      profileAccurate: $('#profileAccurate').checked
    };
  }

  $$('[data-open-auth]').forEach((button) => button.addEventListener('click', () => openAuth(button.dataset.openAuth)));
  const registrationStartButton = $('[data-open-auth="register"]');
  if (registrationStartButton) registrationStartButton.innerHTML = 'Start registration <span>↗</span>';
  const registrationTab = $('.mode-tabs button[data-mode="register"]');
  if (registrationTab) registrationTab.textContent = 'Register';
  $('#backToChoice').addEventListener('click', () => { $('#authPanel').classList.remove('show'); $('#roleChooser').hidden = false; history.replaceState(null, '', location.pathname + location.search); });
  $$('.mode-tabs button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  $('#countryCode').addEventListener('change', updateCountryPresentation);
  $('#nextStep').addEventListener('click', () => { if (validateStep(state.step)) goToStep(state.step + 1); });
  $('#previousStep').addEventListener('click', () => goToStep(state.step - 1));

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = $('#loginMessage');
    const phone = normalizedPhone($('#loginCountry').value, $('#loginPhone').value);
    if (!validPhone(phone) || !$('#loginPassword').value) return showMessage(target, 'Enter your phone number and password.');
    const button = $('#loginForm .primary-button');
    button.disabled = true; button.textContent = 'Please wait…';
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password: $('#loginPassword').value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Unable to sign in.');
      saveSession(data); showMessage(target, 'Signed in. Opening your workspace…', 'success');
      setTimeout(() => { location.href = safeReturn; }, 450);
    } catch (error) { showMessage(target, error.message || 'Unable to connect to the server.'); button.disabled = false; button.innerHTML = 'Log in <span>↗</span>'; }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.step !== 6) return;
    if (!validateStep(6)) return;
    const target = $('#registerMessage');
    const button = $('#createAccount');
    button.disabled = true; button.textContent = 'Creating account…';
    try {
      const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profilePayload()) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Unable to create your account.');
      saveSession(data);
      showMessage(target, 'Account created. Opening your workspace…', 'success');
      setTimeout(() => { location.href = safeReturn; }, 650);
    } catch (error) { showMessage(target, error.message || 'Unable to connect to the server.'); button.disabled = false; button.innerHTML = 'Create account <span>↗</span>'; }
  });

  updateCountryPresentation();
  if (referralCode) {
    $('#referralCode').value = referralCode;
    $('#roleChooser .notice').textContent = 'A referral code was pre-filled from your invitation link. You can review or replace it before continuing.';
  }
  if (location.hash === '#account') openAuth('login');
})();

