class Tile {
	constructor() {
		this.clicked = false;
		this.flagged = false;
		this.innerText = '';
		this.className = '';
	}
	click() {
		this.clicked = !this.flagged;
	}
	render() {
		return {
			className: this.clicked ? this.className : 'not-clicked',
			innerText: this.clicked ? this.innerText : ''
		}
	}
}
class Mine extends Tile {
	constructor() {
		super();
		this.innerText = 'M';
		this.className = 'mine';
	}
	render() {
		return super.render();
	}
}

class Free extends Tile {
	constructor() {
		super();
		this.adjacents = 0;
		this.innerText = this.adjacents;
	}
	click() {
		super.click();
		this.innerText = this.adjacents;
		this.className = `free-${this.adjacents}`;
	}
}

class MineSweeper {
	constructor(root, config) {
		this.root = root;
		this.width = config.width;
		this.height = config.height;
		this.mineRate = config.mineRate;
		this.board = [];
		this.initialize();
	}
	initialize() {
		this.generateBoard();
		this.render();

		// Handle user input
		this.root.addEventListener('click', (evt) => {
			const { target } = evt;
			
		});
	}
	handleLeftClick(x, y) {
		const clickRecursive = (x, y, recursions=0) => {
			const tile = this.getTile(x, y);
			tile.click();

			if (tile.adjacents === 0 && recursions < 20) {
				for (let neighbour of this.getNeighbours(x, y)) {
					const {x: nx, y: ny, tile: ntile} = neighbour;
					if (!ntile.clicked) {
						clickRecursive(nx, ny, recursions+1);
					}
				}
			}
		}
		clickRecursive(x, y);
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
			this.board.push( Math.random() < this.mineRate ? new Mine() : new Free());
		}

		// Place numbers
		for (let i = 0; i < this.width * this.height; i++) {
			if (this.board[i] instanceof Free) {
				const x = i%this.width;
				const y = Math.floor(i/this.width);
				const weight = this.getAdjacentMinesSum(x, y);
				this.board[i].adjacents = weight;
			}
		}
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
		const tbody = document.createElement('tbody');
		for (let y = 0; y < this.height; y++) {
			const row = document.createElement('tr');
			for (let x = 0; x < this.width; x++){
				const cell = document.createElement('td');
				const { className, innerText } = this.getTile(x, y).render();
				cell.className = className;
				cell.innerText = innerText;
				cell.addEventListener('click', () => this.handleLeftClick(x, y));
				row.appendChild(cell);
			}
			tbody.appendChild(row);
		}
		const table = document.createElement('table');
		table.appendChild(tbody);
		this.root.innerHTML = '';
		this.root.appendChild(table);
	}
}
