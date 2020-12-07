class Tile {
	constructor(root=null) {
		this.root = root;
		this.clicked = false;
		this.flagged = false;
		this.innerText = '';
		this.className = '';
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
		this.root.className = [
			(this.flagged ? 'flag' : ''), 
			(this.clicked ? 'clicked ' + this.className : 'not-clicked')
		].join(' ');
	}
}
class Mine extends Tile {
	constructor(root) {
		super(root);
		this.innerText = 'M';
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
		this.render();
		return change;
	}
}

class MineSweeper {
	constructor(root, config) {
		this.root = root;
		this.width = config.width;
		this.height = config.height;
		this.mineRate = config.mineRate;
		this.speed = 40;
		this.board = [];
		this.state = {
			gameOver: false,
			win: false,
			allowUserInput: true,
			waitingForUpdates: false,
			score: 0,
			flags: 0,
			totalMines: 0,
		};
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
		this.state.gameOver = true;
		this.state.win = win;
		this.render();
	}

	checkWin() {
		const totalTiles = this.board.length;
		const clickedTiles = this.board
			.filter((tile) => tile.clicked)
			.reduce((sum, tile) => {
				if (tile instanceof Mine) {
					this.endGame(true);
				}
				return sum + (tile instanceof Free ? 1 : 0);
			}, 0);
		
		if (totalTiles - this.state.totalMines == clickedTiles) {
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
			[-1,  0], 				 [1,  0],
			[-1,  1], [0,  1], [1,  1]
		].map(
			([ox, oy]) => [ox + x, oy + y]
		);
	}
	render() {
		console.log('Rendered');
		const header = document.querySelector('.game-header');
		header.innerHTML = `
			<p>Score: ${this.state.score}</p>
			<p>Flags: ${this.state.flags} / ${this.state.totalMines}</p>
		`;
		if (this.state.gameOver) {
			header.innerHTML += `
				<div class="game-over">
					<h1>${this.state.win ? 'You win!' : 'Game Over'}</h1>
					<p>Score: ${this.state.score}</p>
					<button onclick="MineSweeper.handleRestart()">Play Again</button>
				</div>
			`;
		}
	}
}