class Tile {
	constructor(root=null) {
		this.root = root;
		this.clicked = false;
		this.flagged = false;
		this.innerText = '';
		this.className = '';
		this.extraClass = '';
	}
	click() {
		this.clicked = !this.flagged;
		return this.adjacents || 0;
	}
	rightClick() {
		let change = 0;
		if (this.clicked) {
			return 0;
		}
		if (this.flagged) {
			this.flagged = false;
			this.render();
			return -1;
		} else {
			this.flagged = true;
			this.render();
			return 1;
		}
	}
	setRoot(root) {
		this.root = root;
	}
	render() {
		if (this.root == null) return;
		this.root.innerText = this.clicked ? this.innerText : '';
		const cssClasses = Object.entries({
			[this.extraClass]: this.extraClass,
			['clicked']: this.clicked,
			['not-clicked']: !this.clicked,
			['flag']: this.flagged,
			[this.className]: this.clicked && this.className // Obfuscating
		})
		this.root.className = cssClasses.reduce(
			(a, [cssClass, req]) => (req ? [...a, cssClass] : a)
		, []).join(' ');
	}
}
class Mine extends Tile {
	constructor(root) {
		super(root);
		this.innerText = '';
		this.className = 'mine';
	}
	render() {
		return super.render();
	}
}

class Free extends Tile {
	constructor(root) {
		super(root);
		this.adjacents = 0;
		this.innerText = this.adjacents;
	}
	click() {
		const change = super.click();
		this.innerText = this.adjacents;
		this.className = `free-${this.adjacents}`;
		this.extraClass = '';
		this.render();
		return change;
	}
}

class ScoreBoard {
	constructor() {
		this.scores = [
			{ name: 'Elias', points: 1337 , date: new Date('2020-12-07T20:43:09.763Z') }
		];
	}
	addScore(name, points, date) {
		this.scores.push({ name: name, points: points, date});
	}
	static handleSubmit(evt) {
		evt.preventDefault();
		const { value: name } = evt.target.elements.name;
		// TODO: Handle some local storage saving

		// TODO 2: Find a way to get the score

	}
	render() {
		return `
			<div class="score-board"> 
				${ (
					this.scores
						.sort((score) => score.points)
						.reduce((dom, score) => ( dom + `
						<div class='score-element'>
							<p>${score.name}</p>
							<p>${score.points}</p>
							<p>${dateToString(score.date)}</p>
						</div>
					`), '')
				)}
			</div>
			<div class="score-submit"> 
				<form onsubmit="ScoreBoard.handleSubmit(event)">
					<input type="text" name="name" id="inpName" placeholder="Your name">
					<button type="submit">Submit</button>
				</form>
			</div>
		`;
	}
}

const dateToString = (date) => {
	const months = [
	  'January',
	  'February',
	  'March',
	  'April',
	  'May',
	  'June',
	  'July',
	  'August',
	  'September',
	  'October',
	  'November',
	  'December'
	];
	const monthName = months[date.getMonth()]
	const days = [
	  'Sun',
	  'Mon',
	  'Tue',
	  'Wed',
	  'Thu',
	  'Fri',
	  'Sat'
	];
	const dayName = days[date.getDay()] // Thu
	return `${dayName}, ${date.getDay()} ${monthName} ${date.getYear()}`;
}

class MineSweeper {
	constructor(root, config, debugSettings) {
		this.root = root;
		this.width = config.width;
		this.height = config.height;
		this.mineRate = config.mineRate;
		this.easyTiles = config.easyTiles;
		this.speed = 80;
		this.board = [];
		this.state = {
			gameOver: false,
			win: false,
			allowUserInput: true,
			waitingForUpdates: false,
			scoreBoard: new ScoreBoard(),
			score: 0,
			flags: 0,
			totalMines: 0,
		};
		this.debugSettings = Object.assign({
			winAfterHits: 999999,
		}, debugSettings);
		this.initialize();
	}
	initialize() {
		this.generateBoard();
		this.render();

		// Handle user input
		this.root.addEventListener('click', (evt) => {
			const { target } = evt;
		});

		this.root.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
		});
	}

	endGame(win=false) {
		this.state.allowUserInput = false;
		this.state.win = win;

		// Game Over animation
		for (let tile of this.board.filter(t => t instanceof Mine)) {
			tile.clicked = true;
			tile.render();
		}

		const endScreenDelay = win ? 4000 : 4000;

		setTimeout(() => {
			this.state.gameOver = true;
			this.render();
		}, endScreenDelay);
	}

	checkWin() {
		const totalTiles = this.board.length;
		const freeTilesLeft = this.board.filter(t => (!t.clicked && (t instanceof Free))).length;
		if (
			freeTilesLeft === 0 || 
			0 >= this.debugSettings.winAfterHits
		) {
			this.endGame(true);
		}
	}

	async handleLeftClick(x, y) {
		if (!this.state.allowUserInput || this.state.gameOver) {
			return;
		}
		let lastRender = new Date();
		const clickRecursive = async (x, y, recursions=0) => {
			const tile = this.getTile(x, y);

			if (tile.flagged || tile.clicked) {
				return;
			}

			const scoreChange = tile.click();
			this.state.score += scoreChange;
			if (tile instanceof Mine) {
				this.endGame(false);
				return;
			}

			this.checkWin();

			if (new Date() - lastRender > this.speed) {
				this.render();
				lastRender = new Date();
			}
			if (tile.adjacents === 0 && recursions < 40) {
				await setTimeout( async () => {
					// Update neighbours
					for (let neighbour of this.getNeighbours(x, y)) {
						const {x: nx, y: ny, tile: ntile} = neighbour;
						if (!ntile.clicked) {
							await clickRecursive(nx, ny, recursions+1);
						}
					}
				}, this.speed);
			}
		}
		await clickRecursive(x, y);
		this.debugSettings.winAfterHits--;
		this.checkWin();
		this.render();
	}

	static handleRestart() {
		location.reload();
	}

	handleRightClick(x, y) {
		if (!this.state.allowUserInput || this.state.gameOver) {
			return;
		}
		const tile = this.getTile(x, y)
		const	flagChange = tile.rightClick();
		this.state.flags += flagChange;
		this.render();
	}

	getAdjacentMinesSum(x, y) {
		return this.getNeighbourCoords(x, y).reduce((a, [nx, ny]) => {
			return this.getTile(nx, ny) instanceof Mine ? a + 1 : a;
		}, 0);
	}

	generateBoard() {
		this.board = [];
		// Populate array
		for (let i = 0; i < this.width * this.height; i++) {
			if (Math.random() < this.mineRate) {
				this.board.push(new Mine());
				this.state.totalMines += 1;
			} else {
				this.board.push(new Free());
			}
		}

		// Update numbers
		for (let i = 0; i < this.width * this.height; i++) {
			if (this.board[i] instanceof Free) {
				const x = i%this.width;
				const y = Math.floor(i/this.width);
				const weight = this.getAdjacentMinesSum(x, y);
				this.board[i].adjacents = weight;
			}
		}

		
		if (this.easyTiles > 0) {  // Mark easy start tiles
			let placed = 0, tries = 0;
			const candidates = this.board.filter(t => (t instanceof Free && t.adjacents === 0));
			while (placed < this.easyTiles && tries < 20) {
				for (let tile of candidates) {
					if (Math.random() < 3/this.board.length) {
						tile.extraClass = 'easy-start';
						placed++;
						break;
					}
				}
				tries++;
			}	
		}

		// Draw DOM
		const wrapper = document.createElement('div');
		wrapper.className = 'game-wrapper';

		const header = document.createElement('div');
		header.className = 'game-header';
		header.innerHTML = `
			<p>Score: ${this.state.score}</p>
			<p>Flags: ${this.state.flags} / ${this.state.totalMines}</p>
		`;

		const tbody = document.createElement('tbody');
		for (let y = 0; y < this.height; y++) {
			const row = document.createElement('tr');
			for (let x = 0; x < this.width; x++){
				const tile = this.getTile(x, y);
				const cell = document.createElement('td');
				tile.setRoot(cell);
				tile.render();

				cell.addEventListener('click', () => this.handleLeftClick(x, y));
				cell.addEventListener('contextmenu', (evt) => {
					evt.preventDefault();
					this.handleRightClick(x, y);
				});
				row.appendChild(cell);
			}
			tbody.appendChild(row);
		}
		const table = document.createElement('table');
		table.appendChild(tbody);

		wrapper.appendChild(header);
		wrapper.appendChild(table);

		this.root.innerHTML = '';
		this.root.appendChild(wrapper);
	}

	getTile(x, y) {
		if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
			return null;
		}
		return this.board[x + y*this.width];
	}
	getNeighbours(x, y) {
		return this.getNeighbourCoords(x, y).reduce((a, [nx, ny]) => {
			const tile = this.getTile(nx, ny);
			return tile == null ? a : [...a, {x: nx, y: ny, tile: tile}];
		}, []);
	}
	getNeighbourCoords(x, y) {
		return [
			[-1, -1], [0, -1], [1, -1],
			[-1,  0], 		   [1,  0],
			[-1,  1], [0,  1], [1,  1]
		].map(
			([ox, oy]) => [ox + x, oy + y]
		);
	}
	render() {
		const header = document.querySelector('.game-header');
		header.innerHTML = `
			<p>Score: ${this.state.score}</p>
			<p>Flags: ${this.state.flags} / ${this.state.totalMines}</p>
		`;
		if (this.state.gameOver) {
			header.innerHTML += `
				<div class="game-over-wrapper">
					<div class="game-over-item">
						<h1>${this.state.win ? '🔥 You win! 🔥' : '👹 Game Over 👹'}</h1>
						<p>Score: ${this.state.score}</p>
						<button onclick="MineSweeper.handleRestart()">Play Again</button>
					</div>
					<div class="game-over-item">
						<h2>📢 Scoreboard 📢</h1>
						${this.state.scoreBoard.render()}
						<p>The scoreboard doesn't work yet.</p>
					</div>
				</div>
			`;
			this.root.classList.add('game-over');
		}
		
	}
}