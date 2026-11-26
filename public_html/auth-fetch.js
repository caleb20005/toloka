(function () {
  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    let resource = input;
    const options = init ? { ...init } : {};
    const token = localStorage.getItem('token');

    if (typeof resource === 'string') {
      resource = resource
        .replace(/^http:\/\/localhost:(5000|5500)(\/api\/)/, '$2')
        .replace(/^http:\/\/127\.0\.0\.1:(5000|5500)(\/api\/)/, '$2');
    } else if (resource instanceof Request) {
      const rewrittenUrl = resource.url.replace(/^http:\/\/(localhost|127\.0\.0\.1):(5000|5500)(\/api\/)/, window.location.origin + '$3');
      resource = new Request(rewrittenUrl, resource);
    }

    if (token) {
      const headers = new Headers(options.headers || (resource instanceof Request ? resource.headers : undefined));
      headers.set('Authorization', `Bearer ${token}`);
      options.headers = headers;
    }

    return originalFetch(resource, options);
  };
})();
