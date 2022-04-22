let changeColor = document.getElementById("changeColor");
let elUrl = document.getElementById("url");
let elContent = document.getElementById("content");
let elLoading = document.getElementById("loading");


chrome.tabs.query({ active: true, currentWindow: true }).then(result => {
  request(result[0].url)
})


changeColor.addEventListener("click", async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  request(elUrl.value)
});


function request(url) {
  elContent.classList.add('loading');
  fetch(url).then(r => r.text()).then(html => {
    try {
      const node = new DOMParser().parseFromString(html, "text/html");
      var article = new Readability(node).parse();
      elContent.innerHTML = article.content
    } catch(err) {
      elContent.innerHTML = err;
    }
  }).catch(err => {
    elContent.innerHTML = err;
  }).finally(() => {
    elContent.classList.remove('loading');
  })
}