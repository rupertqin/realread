let changeColor = document.getElementById("changeColor");
let elUrl = document.getElementById("url");
let elContent = document.getElementById("content");

changeColor.addEventListener("click", async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  fetch(elUrl.value).then(r => r.text()).then(html => {
    try {
      const node = new DOMParser().parseFromString(html, "text/html");
      var article = new Readability(node).parse();
      elContent.innerHTML = article.content
    } catch(err) {
      elContent.innerHTML = err;
    }
  }).catch(err => {
    elContent.innerHTML = err;
  })
});

