function isVisible(el: HTMLInputElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function findInputs() {
  const allInputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
  const visibleInputs = allInputs.filter(isVisible);

  const passwordInputs = visibleInputs.filter(el => el.type === 'password');

  const textInputs = visibleInputs.filter(el =>
    el.type === 'text' || el.type === 'email' || !el.type
  );

  let usernameInput: HTMLInputElement | null = null;
  let passwordInput: HTMLInputElement | null = passwordInputs[0] || null;

  if (passwordInput) {
    const idx = visibleInputs.indexOf(passwordInput);
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i--) {
        const el = visibleInputs[i]!;
        if (el.type === 'text' || el.type === 'email' || !el.type) {
          usernameInput = el;
          break;
        }
      }
    }
  }

  if (!usernameInput && textInputs.length > 0) {
    const heuristics = /username|email|login|user|账号|邮箱|用户名/i;
    usernameInput = textInputs.find(el =>
      el.autocomplete === 'username' || el.autocomplete === 'email'
    ) || null;

    if (!usernameInput) {
      usernameInput = textInputs.find(el =>
        heuristics.test(el.name) ||
        heuristics.test(el.id) ||
        heuristics.test(el.placeholder)
      ) || null;
    }

    if (!usernameInput) {
      usernameInput = textInputs[0] || null;
    }
  }

  return { usernameInput, passwordInput };
}

function fillField(input: HTMLInputElement, value: string) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FILL_CREDENTIALS') {
    const { username, password } = message.payload || {};
    const { usernameInput, passwordInput } = findInputs();

    let filledUsername = false;
    let filledPassword = false;

    if (username && usernameInput) {
      fillField(usernameInput, username);
      filledUsername = true;
    }

    if (password && passwordInput) {
      fillField(passwordInput, password);
      filledPassword = true;
    }

    if (filledUsername || filledPassword) {
      const filledList = [];
      if (filledUsername) filledList.push('username');
      if (filledPassword) filledList.push('password');
      sendResponse({ success: true, filled: filledList });
    } else {
      sendResponse({ success: false, error: 'no_fields_found' });
    }
  }
  return true;
});
